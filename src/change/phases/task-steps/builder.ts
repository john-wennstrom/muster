import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { newRun, runError, runOk } from "../../../agents/run-record.ts";
import { runAgent, type WriteAgentRunner } from "../../../agents/spawn.ts";
import { failureBlock, latestFailure, type FailureAttempt } from "../../../execution/recovery.ts";
import { collaborationTask } from "../../../execution/collaboration-task.ts";
import type { ChangeTaskExecutionContext } from "../../../execution/scheduler.ts";
import type { ValidatedTask } from "../../../execution/task-schema.ts";
import type { TaskPipelineBuilderResult } from "../../../execution/task-runner.ts";
import { recordChangeUsage } from "../../../persistence/change-usage-store.ts";
import { tddEvidenceRecordSchema } from "../../../persistence/records.ts";
import { usageFromLegacyRun } from "../../../telemetry/usage.ts";
import { parseAgentJson, type TaskStepContext } from "./context.ts";
import { routeTask } from "./routing.ts";
import { renderPrompt, type RenderedPrompt } from "../../../prompts/render.ts";

const BUILDER_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export const builderResultSchema = z.object({
  claim: z.enum(["completed", "blocked", "design_conflict"]),
  implementationPersisted: z.boolean(),
  reason: z.string().optional(),
  statedFix: z.string().optional(),
  conflict: z.object({
    evidence: z.array(z.string().min(1)).min(1),
    affectedArtifacts: z.array(z.string().min(1)).min(1),
    affectedTasks: z.array(z.string().min(1)).min(1),
    recommendation: z.string().optional(),
  }).optional(),
  tddEvidence: tddEvidenceRecordSchema.optional(),
}).strict();

export function builderPrompt(task: ValidatedTask, priorFailure: FailureAttempt | null = null): RenderedPrompt {
  return renderPrompt("builder", {
    TASK_ID: task.id,
    TASK_DESCRIPTION: task.description,
    REQUIREMENTS: JSON.stringify(task.requirements),
    SCENARIOS: JSON.stringify(task.scenarios),
    VERIFICATION: JSON.stringify(task.verify),
    PRIOR_FAILURE: failureBlock(priorFailure),
  });
}

/**
 * Runs one builder agent for a task and parses its claimed result. A first attempt may be
 * routed to the economy lane and to lower thinking; `attempt` defaults to the first so existing callers are unchanged.
 */
export async function runBuilderStep(
  step: TaskStepContext,
  task: ValidatedTask,
  execution: ChangeTaskExecutionContext,
  signal?: AbortSignal,
  runChild: WriteAgentRunner = runAgent,
  attempt: number = 1,
): Promise<TaskPipelineBuilderResult> {
  const routing = await routeTask(step, task, attempt, signal);
  // The economy model is used only when the user configured one; the thinking is chosen either way.
  const slot = routing.economy && step.economyBuilder ? step.economyBuilder : step.stack.primaryBuilder;
  const run = newRun("BUILDER", slot.model, slot);
  const childId = `builder-${task.id}-${randomUUID()}`;
  try {
    await runChild({
      access: "write",
      run,
      modelStack: step.stack,
      onAgentStart: step.onAgentStart,
      prompt: builderPrompt(task, await latestFailure(step.store, step.changeName, task.id)),
      systemPrompt: slot.systemPrompt,
      appendSystemPrompts: slot.appendSystemPrompts,
      role: "builder",
      runId: step.runId,
      childId,
      task: collaborationTask(task),
      existingWriterLease: execution.writerLease?.record,
      judgment: step.judgment
        ? { runtime: step.judgment, changeName: step.changeName, taskId: task.id }
        : undefined,
      thinking: routing.builderThinking,
      sessionDir: resolve(step.planningCwd, ".fusion", "runs", step.runId, "sessions", childId),
      cwd: execution.worktree.path,
      timeoutMs: BUILDER_TIMEOUT_MS,
      signal,
    });
  } finally {
    await recordChangeUsage(step.store, step.changeName, [
      usageFromLegacyRun(step.runId, "implementation", run, task.id),
    ]);
  }
  if (!runOk(run)) {
    return { claim: "blocked", implementationPersisted: false, reason: runError(run) };
  }
  return builderResultSchema.parse(parseAgentJson(run.text, `Builder for ${task.id}`));
}
