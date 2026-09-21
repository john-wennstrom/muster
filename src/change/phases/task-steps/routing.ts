import type { Thinking } from "../../../agents/model-stack.ts";
import { LANE_POLICY, readLane } from "../../../controller/lane.ts";
import type { ValidatedTask } from "../../../execution/task-schema.ts";
import { modelRoutingDecision, taskRoutingState } from "../../../judgment/decisions/routing-task-model.ts";
import { tryJudge } from "../../../judgment/try.ts";
import type { TaskRouting, TaskStepContext } from "./context.ts";

/** The reviewer thinks at this level unless routing confidently finds the task easy. */
export const DEFAULT_REVIEWER_THINKING: Thinking = "high";

const ORDER: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The lower of two levels, so a level the user configured below the table's is never raised. */
const lowerOf = (left: Thinking, right: Thinking): Thinking =>
  ORDER.indexOf(left) <= ORDER.indexOf(right) ? left : right;

export function configuredRouting(step: TaskStepContext): TaskRouting {
  return { economy: false, builderThinking: step.stack.primaryBuilder.thinking, reviewerThinking: DEFAULT_REVIEWER_THINKING };
}

/**
 * Asks routing once per task, before its first attempt, and remembers the verdict for the review.
 * Everything but a confident answer in enforce mode runs as configured: a retry, a lane that does
 * not permit reduction, disabled or unavailable judgment, shadow mode, and an abstention.
 */
export async function routeTask(
  step: TaskStepContext,
  task: ValidatedTask,
  attempt: number,
  signal?: AbortSignal,
): Promise<TaskRouting> {
  const configured = configuredRouting(step);
  const remember = (routing: TaskRouting): TaskRouting => {
    step.routing?.set(task.id, routing);
    return routing;
  };
  if (attempt !== 1) {
    step.routing?.delete(task.id);
    return configured;
  }
  const judgment = step.judgment;
  if (!judgment || !LANE_POLICY[(await readLane(step.store, step.changeName)).lane].reducesWorkAllowed) return remember(configured);
  const input = {
    description: task.description,
    requirements: task.requirements,
    scenarios: task.scenarios,
    reads: task.reads,
    writes: task.writes,
    verify: task.verify,
  };
  const verdict = await tryJudge(judgment, modelRoutingDecision, {
    input,
    changeName: step.changeName,
    phase: "implementation",
    taskId: task.id,
    state: taskRoutingState(input),
    signal,
  });
  if (verdict?.kind !== "enforce" || !verdict.outcome.act) return remember(configured);
  const { builderThinking, reviewerThinking } = verdict.outcome.value;
  return remember({
    economy: true,
    builderThinking: lowerOf(builderThinking, configured.builderThinking),
    reviewerThinking,
  });
}
