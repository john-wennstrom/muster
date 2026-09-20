import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { newRun, runError, runOk } from "../../../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyBrokeredChild } from "../../../agents/legacy-adapter.ts";
import { collaborationTask } from "../../../execution/collaboration-task.ts";
import type { ChangeTaskExecutionContext } from "../../../execution/scheduler.ts";
import type { ValidatedTask } from "../../../execution/task-schema.ts";
import type { TaskPipelineBuilderResult } from "../../../execution/task-runner.ts";
import { recordChangeUsage } from "../../../persistence/change-usage-store.ts";
import { tddEvidenceRecordSchema } from "../../../persistence/records.ts";
import { usageFromLegacyRun } from "../../../telemetry/usage.ts";
import { parseAgentJson, type TaskStepContext } from "./context.ts";

const BUILDER_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export const builderResultSchema = z.object({
  claim: z.enum(["completed", "blocked", "design_conflict"]),
  implementationPersisted: z.boolean(),
  reason: z.string().optional(),
  conflict: z.object({
    evidence: z.array(z.string().min(1)).min(1),
    affectedArtifacts: z.array(z.string().min(1)).min(1),
    affectedTasks: z.array(z.string().min(1)).min(1),
    recommendation: z.string().optional(),
  }).optional(),
  tddEvidence: tddEvidenceRecordSchema.optional(),
}).strict();

export function builderPrompt(task: ValidatedTask): string {
  return [
    `Implement task ${task.id}: ${task.description}`,
    `Requirements: ${JSON.stringify(task.requirements)}`,
    `Scenarios: ${JSON.stringify(task.scenarios)}`,
    `Verification: ${JSON.stringify(task.verify)}`,
    "Use the available tools and stay within the declared scopes.",
    "Return exactly one JSON TaskPipelineBuilderResult with claim, implementationPersisted, and any reason/conflict/tddEvidence. No markdown fence.",
  ].join("\n\n");
}

/** Runs one builder agent for a task and parses its claimed result. */
export async function runBuilderStep(
  step: TaskStepContext,
  task: ValidatedTask,
  execution: ChangeTaskExecutionContext,
  signal?: AbortSignal,
  runChild: typeof runLegacyBrokeredChild = runLegacyBrokeredChild,
): Promise<TaskPipelineBuilderResult> {
  const slot = step.stack.primaryBuilder;
  const run = newRun("BUILDER", slot.model, slot);
  const childId = `builder-${task.id}-${randomUUID()}`;
  try {
    await runChild({
      run,
      modelStack: step.stack,
      onAgentStart: step.onAgentStart,
      prompt: builderPrompt(task),
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
      thinking: slot.thinking,
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
