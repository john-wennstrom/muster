import type { ModelSlot, ModelStack, Thinking } from "../../../agents/model-stack.ts";
import type { AtomicJsonStore } from "../../../persistence/atomic-json-store.ts";
import type { JudgmentRuntime } from "../../../judgment/ask.ts";
import { HarnessError } from "../../../shared/errors.ts";
import type { AgentRunObserver } from "../../agent-progress.ts";

/**
 * Everything a task step needs from the surrounding run, supplied explicitly so each step
 * can be invoked and asserted without driving a full implementation run.
 */
export interface TaskStepContext {
  runId: string;
  changeName: string;
  /** The planning working directory, which owns the run's scratch session tree. */
  planningCwd: string;
  store: AtomicJsonStore;
  stack: ModelStack;
  onAgentStart?: AgentRunObserver;
  /** Absent means judgment plays no part: no request, no record, no change to any prompt. */
  judgment?: JudgmentRuntime;
  /**
   * The optional economy builder lane, present only when the user configured a model for it.
   * Absent means every builder task runs on the primary builder and routing sends nothing.
   */
  economyBuilder?: ModelSlot | null;
  /** The optional economy reviewer, configured independently of the builder lane. */
  economyReviewer?: ModelSlot | null;
  /**
   * Each task's routing verdict, set once before its first attempt so a single request serves both
   * the builder and the reviewer. A task with no entry runs as configured.
   */
  routing?: Map<string, TaskRouting>;
}

/** What routing chose for one task, carried from its builder to its reviewer. */
export interface TaskRouting {
  /** True when the routing gate acted: the economy lanes are eligible, each when configured. */
  economy: boolean;
  builderThinking: Thinking;
  reviewerThinking: Thinking;
}

export function parseAgentJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch (cause) {
    throw new HarnessError("TASK_OUTCOME_INVALID", `${label} did not return one JSON object`, {}, { cause });
  }
}
