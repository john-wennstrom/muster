import { resolve } from "node:path";
import { newRun, runError, runOk, resolveChildRuntime } from "../../../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyReadOnlyChild } from "../../../agents/legacy-adapter.ts";
import { readSourceDigest } from "../../../execution/change-digests.ts";
import { GitAdapter } from "../../../execution/git.ts";
import type { ChangeTaskExecutionContext } from "../../../execution/scheduler.ts";
import type { ValidatedTask } from "../../../execution/task-schema.ts";
import type {
  TaskPipelineBuilderResult,
  TaskPipelineReviewResult,
  TaskPipelineVerificationResult,
} from "../../../execution/task-runner.ts";
import { reconcileDecisionRecord } from "../../../judgment/audit.ts";
import { reviewTaskFocusDecision, taskFocusState, type TaskFocusItem } from "../../../judgment/gates.ts";
import { JudgmentFixtureMissingError } from "../../../judgment/replay.ts";
import { recordChangeUsage } from "../../../persistence/change-usage-store.ts";
import {
  dispatchTaskCodeReview,
  taskCodeReviewSchema,
  type TaskCodeReview,
} from "../../../review/code-review.ts";
import { HarnessError } from "../../../shared/errors.ts";
import { usageFromLegacyRun } from "../../../telemetry/usage.ts";
import { parseAgentJson, type TaskStepContext } from "./context.ts";

const REVIEW_TIMEOUT_MS = 120_000;

/** The most diff text a focus judgment is given, cut at a file boundary. */
export const FOCUS_DIFF_LIMIT_BYTES = 24_000;

function unquoteGitPath(path: string): string {
  return path.replace(/\\(["\\])/g, "$1");
}

/** Every path a diff changes, from its `diff --git` headers, in order and without repeats. */
export function changedPathsOfDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const [, header = ""] of diff.matchAll(/^diff --git (.+)$/gm)) {
    const same = /^a\/(.+) b\/\1$/.exec(header);
    if (same) {
      paths.add(same[1]!);
      continue;
    }
    const quoted = /^"a\/(.*)" "b\/(.*)"$/.exec(header);
    const renamed = quoted ?? /^a\/(.+) b\/(.+)$/.exec(header);
    if (renamed) {
      paths.add(unquoteGitPath(renamed[1]!));
      paths.add(unquoteGitPath(renamed[2]!));
    }
  }
  return [...paths];
}

/** The leading whole files of a diff that fit in `limitBytes`; a first file that does not fit leaves it empty. */
export function excerptDiff(diff: string, limitBytes: number = FOCUS_DIFF_LIMIT_BYTES): string {
  let excerpt = "";
  let bytes = 0;
  for (const file of diff.split(/(?=^diff --git )/m)) {
    const size = Buffer.byteLength(file, "utf8");
    if (bytes + size > limitBytes) break;
    excerpt += file;
    bytes += size;
  }
  return excerpt;
}

/** Judgment never throws for an operational failure; only a missing test recording is allowed to surface. */
async function judgeFocus(
  step: TaskStepContext,
  task: ValidatedTask,
  diff: string,
  verification: TaskPipelineVerificationResult,
  builder: TaskPipelineBuilderResult,
  signal?: AbortSignal,
): Promise<{ recordId: string | null; items: readonly TaskFocusItem[] }> {
  const none = { recordId: null, items: [] };
  const judgment = step.judgment;
  if (!judgment?.enabled) return none;
  const changedPaths = changedPathsOfDiff(diff);
  const input = {
    contract: { definition: task.description, requirements: task.requirements, scenarios: task.scenarios },
    diffExcerpt: excerptDiff(diff),
    changedPaths,
    tests: verification.evidence,
    scopes: { reads: task.reads, writes: task.writes },
    tddEvidence: builder.tddEvidence ?? null,
  };
  try {
    const verdict = await judgment.judge(reviewTaskFocusDecision, {
      input,
      changeName: step.changeName,
      phase: "implementation",
      taskId: task.id,
      state: taskFocusState(input),
      sourcePaths: changedPaths,
      signal,
    });
    // Only enforce mode hands the outcome over; fallback and shadow leave the prompt alone.
    const items = verdict.kind === "enforce" && verdict.outcome.act ? verdict.outcome.value.items : [];
    return { recordId: verdict.recordId, items };
  } catch (error) {
    if (error instanceof JudgmentFixtureMissingError) throw error;
    return none;
  }
}

/** Records what the review found, and which focus items named an area it raised. Never fails the review. */
async function reconcileFocus(
  step: TaskStepContext,
  recordId: string | null,
  review: TaskCodeReview,
): Promise<void> {
  if (!recordId) return;
  try {
    const areas = [...new Set(review.findings.map((finding) => finding.area))].sort();
    const reconciled = await reconcileDecisionRecord(step.store, step.changeName, recordId, {
      observed: {
        requiredFindings: review.findings.filter((finding) => finding.severity === "required").length,
        recommendations: review.findings.filter((finding) => finding.severity === "recommendation").length,
        areasRaised: areas,
      },
    });
    if (!reconciled.found) return;
    // The record holds the items the gate chose, whether or not this mode handed them over.
    const gate = reconciled.record.gate;
    const chosen = gate?.act ? ((gate.value as { items?: readonly TaskFocusItem[] }).items ?? []) : [];
    await reconcileDecisionRecord(step.store, step.changeName, recordId, {
      observed: {
        focusItemsRaised: chosen.filter((item) => areas.includes(item.area)).map((item) => item.id),
      },
    });
  } catch {
    // Reconciliation is bookkeeping; the reviewer's verdict stands without it.
  }
}

/** Reviews one task's result, taking the builder and verification results it reviews explicitly. */
export async function runReviewStep(
  step: TaskStepContext,
  task: ValidatedTask,
  execution: ChangeTaskExecutionContext,
  builder: TaskPipelineBuilderResult,
  verification: TaskPipelineVerificationResult,
  signal?: AbortSignal,
  runChild: typeof runLegacyReadOnlyChild = runLegacyReadOnlyChild,
): Promise<TaskPipelineReviewResult> {
  const git = new GitAdapter(execution.worktree.path, undefined, undefined, signal);
  const { diff, sourceDigest } = await readSourceDigest(git);
  const sessionsRoot = resolve(step.planningCwd, ".fusion", "runs", step.runId, "sessions");
  const focus = await judgeFocus(step, task, diff, verification, builder, signal);

  const result = await dispatchTaskCodeReview({
    runId: step.runId,
    taskId: task.id,
    cwd: execution.worktree.path,
    sessionsRoot,
    author: { model: step.stack.primaryBuilder.model },
    candidates: step.stack.slots.map((slot) => ({
      model: slot.model,
      available: true,
      readTools: resolveChildRuntime(step.stack, slot, "read").tools,
    })),
    contract: { definition: task.description, requirements: task.requirements, scenarios: task.scenarios },
    diff: { digest: sourceDigest, summary: diff },
    tests: verification.evidence,
    scopes: { reads: task.reads, writes: task.writes, violations: [] },
    tddEvidence: builder.tddEvidence ?? null,
    ...(focus.items.length > 0 ? { focus: focus.items.map((item) => item.phrase) } : {}),
    runner: async (request) => {
      const run = newRun("REVIEWER", request.model, step.stack.slots.find((slot) => slot.model === request.model));
      try {
        await runChild({
          run,
          modelStack: step.stack,
          onAgentStart: step.onAgentStart,
          prompt: `${request.prompt}\n\nReturn exactly one JSON review object; no markdown fence.`,
          role: "reviewer",
          runId: step.runId,
          childId: request.sessionId,
          taskId: task.id,
          description: `Review task ${task.id}`,
          assignee: "reviewer",
          thinking: "high",
          sessionDir: request.sessionDir,
          sessionId: request.sessionId,
          continueTaskSession: true,
          cwd: execution.worktree.path,
          timeoutMs: REVIEW_TIMEOUT_MS,
          signal,
        });
      } finally {
        await recordChangeUsage(step.store, step.changeName, [
          usageFromLegacyRun(step.runId, "implementation", run, task.id),
        ]);
      }
      if (!runOk(run)) throw new HarnessError("REVIEW_ARTIFACT_INVALID", runError(run));
      return {
        review: taskCodeReviewSchema.parse(parseAgentJson(run.text, `Reviewer for ${task.id}`)),
        toolNames: run.toolNames,
      };
    },
  });

  await reconcileFocus(step, focus.recordId, result.review);

  return {
    approved: result.decision.status === "approved",
    findings: result.decision.status === "repair" ? result.decision.findings : [],
  };
}
