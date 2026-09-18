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
import { recordChangeUsage } from "../../../persistence/change-usage-store.ts";
import { dispatchTaskCodeReview, taskCodeReviewSchema } from "../../../review/code-review.ts";
import { HarnessError } from "../../../shared/errors.ts";
import { usageFromLegacyRun } from "../../../telemetry/usage.ts";
import { parseAgentJson, type TaskStepContext } from "./context.ts";

const REVIEW_TIMEOUT_MS = 120_000;

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

  return {
    approved: result.decision.status === "approved",
    findings: result.decision.status === "repair" ? result.decision.findings : [],
  };
}
