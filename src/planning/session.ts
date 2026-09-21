import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ModelSlot, ModelStack, Thinking } from "../agents/model-stack.ts";
import { newRun, runError, runOk, type AgentRun } from "../agents/run-record.ts";
import { runAgent, type ReadAgentRunner } from "../agents/spawn.ts";
import type { ChangeComplexity } from "../controller/complexity-router.ts";
import type { PlanningPhase } from "../controller/planning.ts";
import { recordChangeUsage } from "../persistence/change-usage-store.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import type { RenderedPrompt } from "../prompts/render.ts";
import { HarnessError } from "../shared/errors.ts";
import type { BudgetLedger } from "../telemetry/budget.ts";
import { usageFromLegacyRun } from "../telemetry/usage.ts";
import {
  renderDebatePrompt,
  renderOpinionPrompt,
  renderPlanPrompt,
  type PlanningPromptInput,
} from "./prompts.ts";

export const PLANNING_TIMEOUT_MS = 30 * 60 * 1000;

export type PlanningSessionKind = "plan" | "opinion" | "debate";

/** The stage name a session's usage and child identity carry. */
const STAGE = { plan: "synthesis", opinion: "specialist_opinion", debate: "debate" } as const satisfies Record<PlanningSessionKind, string>;

const PROMPT = { plan: renderPlanPrompt, opinion: renderOpinionPrompt, debate: renderDebatePrompt } as const satisfies
  Record<PlanningSessionKind, (input: PlanningPromptInput) => RenderedPrompt>;

/** Small and medium work plans with less thinking than the configured level; large work keeps it. */
export function thinkingForPlanning(classification: ChangeComplexity, configured: Thinking): Thinking {
  if (classification === "direct") return "low";
  if (classification === "bounded") return "medium";
  return configured;
}

export interface PlanningSessionOptions {
  readonly cwd: string;
  readonly changeName: string;
  readonly phase: PlanningPhase;
  readonly runId: string;
  readonly stack: ModelStack;
  readonly slot: ModelSlot;
  readonly classification: ChangeComplexity;
  readonly usageStore: AtomicJsonStore;
  readonly budget: BudgetLedger;
  readonly onAgentStart?: (run: AgentRun) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Replaces the child process, as tests do. */
  readonly runChild?: ReadAgentRunner;
}

/**
 * Runs one planning session through the single spawn entry point and returns its answer. Usage is
 * recorded and charged to the planning budget whether or not the session succeeds, and a session
 * that does not finish cleanly fails the command with the reason.
 */
export async function runPlanningSession(
  kind: PlanningSessionKind,
  input: PlanningPromptInput,
  options: PlanningSessionOptions,
): Promise<string> {
  const stage = STAGE[kind];
  const run = newRun(options.slot.architect ? "ARCHITECT" : "BUILDER", options.slot.model, options.slot);
  const childId = `${stage}-${randomUUID()}`;
  try {
    await (options.runChild ?? runAgent)({
      access: "read",
      run,
      modelStack: options.stack,
      onAgentStart: options.onAgentStart,
      prompt: PROMPT[kind](input),
      systemPrompt: options.slot.systemPrompt,
      appendSystemPrompts: options.slot.appendSystemPrompts,
      role: "architect",
      runId: options.runId,
      childId,
      taskId: `planning.${stage}`,
      description: `${options.phase} ${options.changeName}: ${stage}`,
      assignee: options.slot.id,
      thinking: thinkingForPlanning(options.classification, options.slot.thinking),
      toolMode: "standard",
      sessionDir: resolve(options.cwd, ".fusion", "runs", options.runId, "sessions", childId),
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? PLANNING_TIMEOUT_MS,
      signal: options.signal,
    });
  } finally {
    const usage = usageFromLegacyRun(options.runId, "planning", run, `planning.${stage}`);
    await recordChangeUsage(options.usageStore, options.changeName, [usage]);
    options.budget.record(usage);
  }
  if (!runOk(run)) {
    throw new HarnessError("PLANNING_AGENT_FAILED", `Planning agent failed: ${runError(run)}`, {
      phase: options.phase,
      stage,
      model: options.slot.model,
    });
  }
  return run.text;
}
