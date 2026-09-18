import type { ModelStack } from "../../../../extensions/fusion-harness/modules/model-stack.ts";
import type { AtomicJsonStore } from "../../../persistence/atomic-json-store.ts";
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
}

export function parseAgentJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch (cause) {
    throw new HarnessError("TASK_OUTCOME_INVALID", `${label} did not return one JSON object`, {}, { cause });
  }
}
