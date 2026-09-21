import { resolve } from "node:path";
import { resolveChildRuntime } from "../../../agents/child-runtime.ts";
import { newRun, runError, runOk } from "../../../agents/run-record.ts";
import { runAgent, type ReadAgentRunner } from "../../../agents/spawn.ts";
import { readSourceDigest } from "../../../execution/change-digests.ts";
import { GitAdapter } from "../../../execution/git.ts";
import type { ChangeTaskExecutionContext } from "../../../execution/scheduler.ts";
import type { ValidatedTask } from "../../../execution/task-schema.ts";
import type {
  TaskPipelineBuilderResult,
  TaskPipelineReviewResult,
  TaskPipelineVerificationResult,
} from "../../../execution/task-runner.ts";
import { reviewTaskFocusDecision, taskFocusState, type TaskFocusGateValue, type TaskFocusItem } from "../../../judgment/decisions/review-task-focus.ts";
import { tryJudge, type TriedVerdict } from "../../../judgment/try.ts";
import { recordChangeUsage } from "../../../persistence/change-usage-store.ts";
import {
  dispatchTaskCodeReview,
  taskCodeReviewSchema,
  type TaskCodeReview,
} from "../../../review/code-review.ts";
import { HarnessError } from "../../../shared/errors.ts";
import { usageFromLegacyRun } from "../../../telemetry/usage.ts";
import { parseAgentJson, type TaskStepContext } from "./context.ts";
import { configuredRouting } from "./routing.ts";
import { skipGuardFailures } from "./review-skip.ts";
import { renderPrompt, type RenderedPrompt } from "../../../prompts/render.ts";

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

interface JudgedFocus {
  /** Null when judgment played no part, in which case there is nothing to reconcile. */
  readonly verdict: TriedVerdict<TaskFocusGateValue> | null;
  readonly items: readonly TaskFocusItem[];
  /** Whether the enforced gate found every answer confidently good, so the review may be skipped. */
  readonly skipRequested: boolean;
  readonly diffExcerpt: string;
  readonly changedPaths: readonly string[];
}

async function judgeFocus(
  step: TaskStepContext,
  task: ValidatedTask,
  diff: string,
  verification: TaskPipelineVerificationResult,
  builder: TaskPipelineBuilderResult,
  signal?: AbortSignal,
): Promise<JudgedFocus> {
  const judgment = step.judgment;
  const changedPaths = changedPathsOfDiff(diff);
  const diffExcerpt = excerptDiff(diff);
  if (!judgment) return { verdict: null, items: [], skipRequested: false, diffExcerpt, changedPaths };
  const input = {
    contract: { definition: task.description, requirements: task.requirements, scenarios: task.scenarios },
    diffExcerpt,
    changedPaths,
    tests: verification.evidence,
    scopes: { reads: task.reads, writes: task.writes },
    tddEvidence: builder.tddEvidence ?? null,
  };
  const verdict = await tryJudge(judgment, reviewTaskFocusDecision, {
    input,
    changeName: step.changeName,
    phase: "implementation",
    taskId: task.id,
    state: taskFocusState(input),
    sourcePaths: changedPaths,
    signal,
  });
  // Only enforce mode hands the outcome over; shadow leaves the prompt alone.
  const enforced = verdict?.kind === "enforce" && verdict.outcome.act ? verdict.outcome.value : null;
  return { verdict, items: enforced?.items ?? [], skipRequested: enforced?.skip === true, diffExcerpt, changedPaths };
}

/** Records what the review found, and which focus items named an area it raised. */
async function reconcileFocus(
  verdict: TriedVerdict<TaskFocusGateValue> | null,
  review: TaskCodeReview,
  guardsHold: boolean,
): Promise<void> {
  if (!verdict) return;
  const areas = [...new Set(review.findings.map((finding) => finding.area))].sort();
  const record = await verdict.reconcile({
    requiredFindings: review.findings.filter((finding) => finding.severity === "required").length,
    recommendations: review.findings.filter((finding) => finding.severity === "recommendation").length,
    areasRaised: areas,
  });
  if (!record) return;
  // The record holds the items the gate chose, whether or not this mode handed them over.
  const gate = record.gate;
  const chosen = gate?.act ? ((gate.value as { items?: readonly TaskFocusItem[] }).items ?? []) : [];
  await verdict.reconcile({
    focusItemsRaised: chosen.filter((item) => areas.includes(item.area)).map((item) => item.id),
    // Shadow mode never skips; it records that the review would have been skipped.
    ...(verdict.kind === "shadow" && guardsHold && gate?.act && (gate.value as { skip?: boolean }).skip === true
      ? { wouldHaveSkipped: true }
      : {}),
  });
}

/** The task reviewer's request followed by the output contract for a spawned reviewer. */
export function taskReviewerPrompt(reviewRequest: string): RenderedPrompt {
  return renderPrompt("task-reviewer", { REVIEW_REQUEST: reviewRequest });
}

/** Reviews one task's result, taking the builder and verification results it reviews explicitly. */
export async function runReviewStep(
  step: TaskStepContext,
  task: ValidatedTask,
  execution: ChangeTaskExecutionContext,
  builder: TaskPipelineBuilderResult,
  verification: TaskPipelineVerificationResult,
  signal?: AbortSignal,
  runChild: ReadAgentRunner = runAgent,
): Promise<TaskPipelineReviewResult> {
  const git = new GitAdapter(execution.worktree.path, undefined, undefined, signal);
  const { diff, sourceDigest } = await readSourceDigest(git);
  const sessionsRoot = resolve(step.planningCwd, ".fusion", "runs", step.runId, "sessions");
  const focus = await judgeFocus(step, task, diff, verification, builder, signal);
  const guardFailures = focus.verdict
    ? await skipGuardFailures({ step, task, builder, verification, diff, diffExcerpt: focus.diffExcerpt, changedPaths: focus.changedPaths })
    : ["judgment played no part"];
  // A skip needs the decision's record to name, so a record that could not be written means a review.
  if (focus.skipRequested && guardFailures.length === 0 && focus.verdict?.recordId) {
    await focus.verdict.reconcile({ skippedReview: true });
    return { approved: true, findings: [], skipped: { decisionRecordId: focus.verdict.recordId } };
  }
  if (focus.skipRequested) await focus.verdict?.reconcile({ skipRefused: guardFailures });
  const routing = step.routing?.get(task.id) ?? configuredRouting(step);
  // The economy reviewer serves only a task routing found economy-eligible, and only when configured.
  const economy = routing.economy ? step.economyReviewer ?? null : null;
  const slots = economy ? [economy] : step.stack.slots;

  const result = await dispatchTaskCodeReview({
    runId: step.runId,
    taskId: task.id,
    cwd: execution.worktree.path,
    sessionsRoot,
    author: { model: step.stack.primaryBuilder.model },
    candidates: slots.map((slot) => ({
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
      const run = newRun("REVIEWER", request.model, slots.find((slot) => slot.model === request.model));
      try {
        await runChild({
          access: "read",
          run,
          modelStack: step.stack,
          onAgentStart: step.onAgentStart,
          prompt: taskReviewerPrompt(request.prompt),
          role: "reviewer",
          runId: step.runId,
          childId: request.sessionId,
          taskId: task.id,
          description: `Review task ${task.id}`,
          assignee: "reviewer",
          thinking: routing.reviewerThinking,
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

  await reconcileFocus(focus.verdict, result.review, guardFailures.length === 0);

  return {
    approved: result.decision.status === "approved",
    findings: result.decision.status === "repair" ? result.decision.findings : [],
  };
}
