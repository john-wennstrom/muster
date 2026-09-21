import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDependencyReport } from "../agents/reports.ts";
import { checkpointPlannedManualAction } from "../controller/manual-checkpoint.ts";
import { listDecisionRecords, reconcileDecisionRecord } from "../judgment/audit.ts";
import { modelRoutingDecision } from "../judgment/decisions/routing-task-model.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { checkpointRecordSchema, reviewRecordSchema, taskResultSchema, type CheckpointRecord } from "../persistence/records.ts";
import type { ChangeRun } from "../persistence/run-store.ts";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import { readSourceDigest } from "./change-digests.ts";
import { settleFailedAttempt, type RecoveryEnd } from "./failed-attempt.ts";
import type { TaskDagRecord } from "../persistence/records.ts";
import { GitAdapter } from "./git.ts";
import type { RunManifestKeeper } from "./run-manifest.ts";
import { affectedTaskBranch, type ChangeTaskExecutionContext } from "./scheduler.ts";
import type { ValidatedTask, ValidatedTaskDocument } from "./task-schema.ts";
import {
  runTaskPipeline,
  synchronizeTaskCheckbox,
  type TaskPipelineBuilderResult,
  type TaskPipelineReviewResult,
  type TaskPipelineVerificationResult,
} from "./task-runner.ts";

/** The three steps of a task, which the caller supplies so this module knows nothing of the change surface. */
export interface UnitSteps {
  /** One-based; only a first attempt may be routed to the economy lane. */
  runBuilder(task: ValidatedTask, context: ChangeTaskExecutionContext, signal: AbortSignal | undefined, attempt: number): Promise<TaskPipelineBuilderResult>;
  runVerification(task: ValidatedTask, context: ChangeTaskExecutionContext, signal?: AbortSignal): Promise<TaskPipelineVerificationResult>;
  runReview(
    task: ValidatedTask,
    builder: TaskPipelineBuilderResult,
    verification: TaskPipelineVerificationResult,
    context: ChangeTaskExecutionContext,
    signal?: AbortSignal,
  ): Promise<TaskPipelineReviewResult>;
}

export interface UnitRunnerInput {
  runId: string;
  changeName: string;
  planningCwd: string;
  store: AtomicJsonStore;
  changeRun: Pick<ChangeRun, "readRecords">;
  dag: TaskDagRecord;
  document: ValidatedTaskDocument;
  tasksPath: string;
  /** The current text of tasks.md, which task completion rewrites. */
  state: { contents: string };
  keeper: RunManifestKeeper;
  /** Checkpoints awaiting a person; the runner adds the ones it creates. */
  pendingCheckpoints: CheckpointRecord[];
  steps: UnitSteps;
  /** The reviewer model a review record names when the manifest has none. */
  fallbackReviewerModel: string;
  now: () => Date;
  /** Absent means a failed attempt is recorded and nothing more: no request, no change of outcome. */
  judgment?: JudgmentRuntime;
  /** The scheduler's attempt limit; a retry is never chosen at it. */
  maxAttempts: number;
  /** Filled with the tasks a recovery decision ended; the phase maps them to the command's outcome. */
  recoveryEnds: RecoveryEnd[];
}

/**
 * Measurement only: merges a task's first-attempt outcome into the routing record that attempt
 * wrote, along with the lane it actually ran on. The lane is read off the record: it was the
 * economy lane only when the gate's acting outcome was handed to the builder step, which is
 * enforce mode. A record from before `since` belongs to an earlier run and is left alone, as is
 * one that already holds an outcome, so a later attempt never overwrites the first. A missing
 * record is normal, since routing is usually off, and a failure here must not fail the task.
 */
async function reconcileTaskRoutingOutcome(input: {
  store: AtomicJsonStore;
  changeName: string;
  taskId: string;
  status: string;
  since: string;
}): Promise<void> {
  try {
    const latest = (await listDecisionRecords(input.store, input.changeName))
      .filter((record) => record.decision === modelRoutingDecision.id && record.taskId === input.taskId && record.createdAt >= input.since)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    if (!latest || latest.observed.outcome !== undefined) return;
    await reconcileDecisionRecord(input.store, input.changeName, latest.recordId, {
      observed: { lane: latest.acted ? "economy" : "primary", outcome: input.status },
    });
  } catch {
    // Reconciliation is measurement; the task's own outcome stands without it.
  }
}

/**
 * The scheduler's execute callback for one task: a planned manual task checkpoints (or completes
 * once confirmed); any other task runs the pipeline of builder, test-first check, verification,
 * review, evidence persistence and checkbox synchronization, and records its first attempt.
 */
export function createUnitRunner(input: UnitRunnerInput) {
  const { store, runId, changeName, keeper, state } = input;

  const completeConfirmedManualTask = async (task: ValidatedTask, checkpoint: CheckpointRecord, context: ChangeTaskExecutionContext, signal?: AbortSignal) => {
    const completedAt = input.now().toISOString();
    const { sourceDigest } = await readSourceDigest(new GitAdapter(context.worktree.path, undefined, undefined, signal));
    const confirmation = `manual checkpoint ${checkpoint.id} confirmed by ${checkpoint.confirmedBy} at ${checkpoint.confirmedAt}: ${task.manual!.expectedOutcome}`;
    await store.write(runId, `task-results/${task.id}.json`, taskResultSchema.parse({
      schemaVersion: 1, runId, taskId: task.id, outcome: "completed", sourceDigest, verificationEvidence: [confirmation], completedAt,
    }));
    await store.write(runId, `reports/${task.id}.json`, createDependencyReport({
      schemaVersion: 1, runId, taskId: task.id, outcome: "completed", summary: task.description, changedInterfaces: [], evidence: [confirmation], createdAt: completedAt,
    }));
    state.contents = synchronizeTaskCheckbox(state.contents, { ...task, metadata: {} }, {
      status: "completed", taskId: task.id, synchronizeCheckbox: true, invalidatePlanningReview: false, blockAffectedBranch: false,
    });
    await writeFile(input.tasksPath, state.contents, "utf8");
    await keeper.recordTask(task.id, "completed", input.pendingCheckpoints.map(({ id }) => id));
    return { outcome: "completed" as const };
  };

  const runManualTask = async (task: ValidatedTask, context: ChangeTaskExecutionContext, signal?: AbortSignal) => {
    // A planned manual task is the person's step, not a builder's. Once its checkpoint is
    // confirmed the step is done, so it completes here instead of pausing a second time.
    const latest = (await input.changeRun.readRecords("checkpoints", checkpointRecordSchema))
      .filter((candidate) => candidate.taskId === task.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (latest?.status === "confirmed") return completeConfirmedManualTask(task, latest, context, signal);
    const checkpoint = await checkpointPlannedManualAction({
      store, runId, changeName, taskId: task.id, branch: affectedTaskBranch(input.dag, task.id), manual: task.manual!,
    });
    input.pendingCheckpoints.push(checkpoint);
    await keeper.recordTask(task.id, "awaiting_user", input.pendingCheckpoints.map(({ id }) => id));
    return { outcome: "awaiting_user" as const };
  };

  return async (scheduledTask: { id: string }, attempt: number, context: ChangeTaskExecutionContext, signal?: AbortSignal) => {
    const task = input.document.tasks.find((candidate) => candidate.id === scheduledTask.id)!;
    if (task.manual) return runManualTask(task, context, signal);

    // Measurement only: the first attempt's outcome, against the lane it ran on. An attempt that
    // throws is a first attempt that did not complete, so it is recorded too.
    const attemptStartedAt = new Date().toISOString();
    const recordFirstAttemptOutcome = async (status: string): Promise<void> => {
      if (attempt === 1) await reconcileTaskRoutingOutcome({ store, changeName, taskId: task.id, status, since: attemptStartedAt });
    };
    let verificationEvidence: readonly string[] = [];
    let reviewFindings: readonly string[] = [];
    let verification: TaskPipelineVerificationResult | undefined;
    let review: TaskPipelineReviewResult | undefined;
    let statedFix: string | undefined;
    // An escalated task is left ready, to run again once the change is re-reviewed under its new lane.
    const recordEnd = () => keeper.recordTask(
      task.id,
      input.recoveryEnds.at(-1)?.kind === "escalate" ? "ready" : "blocked",
      input.pendingCheckpoints.map(({ id }) => id),
    );
    const settle = (outcome: string, evidence: readonly string[], retryEligible: boolean) => settleFailedAttempt({
      store, changeName, task, attempt, maxAttempts: input.maxAttempts, worktreePath: context.worktree.path, signal,
      now: input.now, keeper, judgment: input.judgment, ends: input.recoveryEnds, outcome, evidence,
      reproduction: verification?.failure
        ? { command: verification.failure.command, exitCode: verification.failure.exitCode, output: verification.failure.output }
        : null,
      statedFix, retryEligible,
    });
    const attemptPipeline = () => runTaskPipeline({
      runId,
      sessionsRoot: resolve(input.planningCwd, ".fusion", "runs", runId, "sessions"),
      contents: state.contents,
      task: {
        ...task,
        metadata: {
          id: task.id, dependsOn: task.dependsOn, role: task.role, reads: task.reads, writes: task.writes,
          requirements: task.requirements, scenarios: task.scenarios, verify: task.verify, manual: task.manual,
        },
      },
      behaviorChanging: true,
      requirements: task.requirements,
      scenarios: task.scenarios,
      reviewBudgetAvailable: true,
      runBuilder: async () => {
        const built = await input.steps.runBuilder(task, context, signal, attempt);
        statedFix = built.statedFix ?? built.reason;
        return built;
      },
      runVerification: async () => {
        verification = await input.steps.runVerification(task, context, signal);
        verificationEvidence = verification.evidence;
        return verification;
      },
      runReview: async ({ builder, verification: verified }) => {
        review = await input.steps.runReview(task, builder, verified, context, signal);
        reviewFindings = review.findings;
        return review;
      },
      persistEvidence: async ({ builder }) => {
        const { sourceDigest } = await readSourceDigest(new GitAdapter(context.worktree.path, undefined, undefined, signal));
        const at = input.now().toISOString();
        await store.write(runId, `task-results/${task.id}.json`, taskResultSchema.parse({
          schemaVersion: 1, runId, taskId: task.id, outcome: "completed", sourceDigest, verificationEvidence, completedAt: at,
        }));
        await store.write(runId, `reviews/task-${task.id}.json`, reviewRecordSchema.parse({
          schemaVersion: 1, runId, taskId: task.id, kind: "task",
          verdict: reviewFindings.length > 0 ? "REVISE" : "APPROVE",
          artifactDigest: sourceDigest,
          // A skipped review says so: nothing read the diff, and the record names the decision that said it need not.
          model: review?.skipped ? "skipped" : keeper.current.modelAssignments.reviewer ?? input.fallbackReviewerModel,
          findings: reviewFindings,
          ...(review?.skipped ? { basis: "judgment" as const, judgmentRecordId: review.skipped.decisionRecordId } : {}),
          createdAt: at,
        }));
        if (builder.tddEvidence) await store.write(runId, `tdd/${task.id}.json`, builder.tddEvidence);
        await store.write(runId, `reports/${task.id}.json`, createDependencyReport({
          schemaVersion: 1, runId, taskId: task.id, outcome: "completed", summary: task.description,
          changedInterfaces: [], evidence: [...verificationEvidence], createdAt: at,
        }));
      },
    });
    let pipeline: Awaited<ReturnType<typeof attemptPipeline>>;
    try {
      pipeline = await attemptPipeline();
    } catch (error) {
      await recordFirstAttemptOutcome("failed");
      // A thrown attempt is retried by the scheduler as it always was, unless the decision ends the task.
      const ended = await settle("error", [error instanceof Error ? error.message : String(error)], false);
      if (ended?.outcome !== "blocked") throw error;
      await recordEnd();
      return ended;
    }
    state.contents = pipeline.contents;
    await writeFile(input.tasksPath, state.contents, "utf8");
    await recordFirstAttemptOutcome(pipeline.outcome.status);
    const failedVerification = verification?.passed === false;
    const repairsRequired = review !== undefined && !review.approved;
    const ended = pipeline.outcome.status === "blocked"
      ? await settle(
        "blocked",
        failedVerification ? verificationEvidence : repairsRequired ? reviewFindings : [pipeline.outcome.reason ?? "the task was blocked"],
        failedVerification || repairsRequired,
      )
      : null;
    if (ended) {
      // A retry leaves the manifest as it is; the next attempt records its own result.
      if (ended.outcome === "blocked") await recordEnd();
      return ended;
    }
    await keeper.recordTask(task.id, pipeline.outcome.status === "completed" ? "completed" : pipeline.outcome.status, input.pendingCheckpoints.map(({ id }) => id));
    return { outcome: pipeline.outcome.status, error: pipeline.outcome.reason };
  };
}
