import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { ModelSlot } from "../../../../extensions/fusion-harness/modules/model-stack.ts";
import { newRun, runError, runOk } from "../../../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyBrokeredChild } from "../../../agents/legacy-adapter.ts";
import { collaborationTask } from "../../../execution/collaboration-task.ts";
import type { ChangeTaskExecutionContext } from "../../../execution/scheduler.ts";
import type { ValidatedTask } from "../../../execution/task-schema.ts";
import type { TaskPipelineBuilderResult } from "../../../execution/task-runner.ts";
import { modelRoutingDecision, taskRoutingState } from "../../../judgment/gates.ts";
import { JudgmentFixtureMissingError } from "../../../judgment/replay.ts";
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

/**
 * Chooses the builder slot. Every path but one is the primary builder: the economy lane is used
 * only for a first attempt, with a lane configured, in enforce mode, when the routing gate acts.
 * A retry, an absent lane, a disabled or unavailable judgment, shadow mode, and an abstention
 * all use the primary builder, and only a first attempt with a lane sends anything. Judgment
 * never throws for an operational failure; only a missing test recording is allowed to surface.
 */
async function chooseBuilderSlot(
  step: TaskStepContext,
  task: ValidatedTask,
  attempt: number,
  signal?: AbortSignal,
): Promise<ModelSlot> {
  const primary = step.stack.primaryBuilder;
  const lane = step.economyBuilder;
  const judgment = step.judgment;
  if (attempt !== 1 || !lane || !judgment?.enabled) return primary;
  const input = {
    description: task.description,
    requirements: task.requirements,
    scenarios: task.scenarios,
    reads: task.reads,
    writes: task.writes,
    verify: task.verify,
  };
  try {
    const verdict = await judgment.judge(modelRoutingDecision, {
      input,
      changeName: step.changeName,
      phase: "implementation",
      taskId: task.id,
      state: taskRoutingState(input),
      signal,
    });
    return verdict.kind === "enforce" && verdict.outcome.act ? lane : primary;
  } catch (error) {
    if (error instanceof JudgmentFixtureMissingError) throw error;
    return primary;
  }
}

/**
 * Runs one builder agent for a task and parses its claimed result. A first attempt may be
 * routed to the economy lane; `attempt` defaults to the first so existing callers are unchanged.
 */
export async function runBuilderStep(
  step: TaskStepContext,
  task: ValidatedTask,
  execution: ChangeTaskExecutionContext,
  signal?: AbortSignal,
  runChild: typeof runLegacyBrokeredChild = runLegacyBrokeredChild,
  attempt: number = 1,
): Promise<TaskPipelineBuilderResult> {
  const slot = await chooseBuilderSlot(step, task, attempt, signal);
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
