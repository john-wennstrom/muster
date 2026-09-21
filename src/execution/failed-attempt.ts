import { escalateLane, LANES, type Lane } from "../controller/lane.ts";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import { taskRecoveryDecision, taskRecoveryState } from "../judgment/decisions/task-recovery.ts";
import { tryJudge } from "../judgment/try.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { changeRunId } from "../persistence/change-usage-store.ts";
import { GitAdapter } from "./git.ts";
import { failurePath, recordFailure, type FailureInput } from "./recovery.ts";
import type { RunManifestKeeper } from "./run-manifest.ts";
import type { ValidatedTask } from "./task-schema.ts";

/** How a task ended a command under judgment: the change moved up a lane, or a person has to act. */
export interface RecoveryEnd {
  taskId: string;
  kind: "escalate" | "stop";
  reason: string;
  /** Where the failure the decision read is kept. */
  failurePath: string;
  /** The lane the change now runs on, for an escalation. */
  lane?: Lane;
}

export interface FailedAttempt {
  store: AtomicJsonStore;
  changeName: string;
  task: ValidatedTask;
  /** One-based. */
  attempt: number;
  maxAttempts: number;
  worktreePath: string;
  signal?: AbortSignal;
  now: () => Date;
  keeper: RunManifestKeeper;
  judgment?: JudgmentRuntime;
  /** Filled here; the phase maps it to the command's outcome. */
  ends: RecoveryEnd[];
  outcome: string;
  evidence: readonly string[];
  reproduction: FailureInput["reproduction"];
  statedFix?: string;
  /** Only a failed verification or required reviewer repairs can be retried; a builder's own block cannot. */
  retryEligible: boolean;
}

/** What the scheduler is told: retry the task, or end it blocked. `null` leaves the ordinary outcome alone. */
export type RecoveryResult = { outcome: "failed" | "blocked"; error: string } | null;

const recordedPath = (changeName: string, taskId: string): string =>
  `.fusion/runs/${changeRunId(changeName)}/${failurePath(taskId)}`;

async function changedPaths(worktreePath: string, signal?: AbortSignal): Promise<string[]> {
  try {
    return (await new GitAdapter(worktreePath, undefined, undefined, signal).status()).map((entry) => entry.path);
  } catch {
    return [];
  }
}

/**
 * Records a failed attempt, then asks `task.recovery` once. Only a confident answer in enforce
 * mode changes anything: retry hands the scheduler a `failed` result (its own limit still
 * applies, and a retry is never chosen at that limit), and escalate or stop end the task blocked.
 * With judgment off, unavailable, uncertain or in shadow mode nothing changes, and the record
 * is left showing what actually happened. Recording the failure never fails the task.
 */
export async function settleFailedAttempt(input: FailedAttempt): Promise<RecoveryResult> {
  let recorded;
  try {
    recorded = await recordFailure(input.store, input.changeName, input.task.id, {
      attempt: input.attempt,
      outcome: input.outcome,
      evidence: input.evidence,
      reproduction: input.reproduction,
      ...(input.statedFix ? { statedFix: input.statedFix } : {}),
      changedPaths: await changedPaths(input.worktreePath, input.signal),
      recordedAt: input.now().toISOString(),
    });
  } catch {
    return null;
  }
  if (!input.judgment || input.signal?.aborted) return null;

  const lane = input.keeper.current.lane ?? "medium";
  const recoveryInput = {
    taskDefinition: `${input.task.description}\nRequirements: ${JSON.stringify(input.task.requirements)}\nScenarios: ${JSON.stringify(input.task.scenarios)}`,
    lane,
    failure: recorded,
  };
  const verdict = await tryJudge(input.judgment, taskRecoveryDecision, {
    input: recoveryInput,
    changeName: input.changeName,
    phase: "implementation",
    taskId: input.task.id,
    state: taskRecoveryState(recoveryInput),
    signal: input.signal,
  });
  if (!verdict) return null;
  const observed = { outcome: input.outcome, attempt: input.attempt };
  if (verdict.kind === "shadow" || !verdict.outcome.act) {
    await verdict.reconcile({ ...observed, action: "none" });
    return null;
  }
  const { action } = verdict.outcome.value;
  const reason = `${input.outcome}: ${input.evidence[0] ?? "the attempt did not complete"}`;

  if (action === "retry") {
    const allowed = input.retryEligible && input.attempt < input.maxAttempts;
    await verdict.reconcile({ ...observed, action: allowed ? "retry" : "none" });
    return allowed ? { outcome: "failed", error: reason } : null;
  }
  if (action === "escalate") {
    const next = LANES[LANES.indexOf(lane) + 1];
    if (!next) {
      await verdict.reconcile({ ...observed, action: "none" });
      return null;
    }
    await escalateLane(input.store, input.changeName, next, `task ${input.task.id}: ${reason}`, input.now);
    await input.keeper.recordLane(next);
    input.ends.push({ taskId: input.task.id, kind: "escalate", reason, failurePath: recordedPath(input.changeName, input.task.id), lane: next });
    await verdict.reconcile({ ...observed, action: "escalate" });
    return { outcome: "blocked", error: `escalated to the ${next} lane: ${reason}` };
  }
  input.ends.push({ taskId: input.task.id, kind: "stop", reason, failurePath: recordedPath(input.changeName, input.task.id) });
  await verdict.reconcile({ ...observed, action: "stop" });
  return { outcome: "blocked", error: `stopped for a person: ${reason}` };
}
