import { LANE_POLICY, readLane } from "../../../controller/lane.ts";
import { latestFailure } from "../../../execution/recovery.ts";
import type { ValidatedTask } from "../../../execution/task-schema.ts";
import type { TaskPipelineBuilderResult, TaskPipelineVerificationResult } from "../../../execution/task-runner.ts";
import { deniedPaths } from "../../../judgment/egress.ts";
import { scopeMatches } from "../../../shared/scope.ts";
import type { TaskStepContext } from "./context.ts";

export interface SkipGuardInput {
  step: TaskStepContext;
  task: ValidatedTask;
  builder: TaskPipelineBuilderResult;
  verification: TaskPipelineVerificationResult;
  diff: string;
  /** The leading part of the diff a focus judgment was given. */
  diffExcerpt: string;
  changedPaths: readonly string[];
}

/**
 * The guards a skipped review needs beyond the judged answers, each a fact the harness can check
 * itself. Returns what failed, so an empty list means every guard holds. Mode is not one of them:
 * enforce acts on a skip, and shadow only records that it would have.
 */
export async function skipGuardFailures(input: SkipGuardInput): Promise<string[]> {
  const { step, task } = input;
  const failed: string[] = [];
  const lane = (await readLane(step.store, step.changeName)).lane;
  if (!LANE_POLICY[lane].reducesWorkAllowed) failed.push(`the ${lane} lane does not permit reduced work`);
  if (!input.verification.passed) failed.push("verification did not pass");
  if (!input.builder.tddEvidence) failed.push("there is no accepted test-first evidence");
  // The routing entry is set only on a first attempt; a task that failed before has a record.
  if (!step.routing?.has(task.id) || await latestFailure(step.store, step.changeName, task.id)) {
    failed.push("this is not the task's first attempt");
  }
  if (input.changedPaths.length === 0) failed.push("the diff changes nothing");
  if (input.diffExcerpt.length !== input.diff.length) failed.push("the diff excerpt is incomplete");
  const outside = input.changedPaths.filter((path) => !task.writes.some((scope) => scopeMatches(path, scope)));
  if (outside.length > 0) failed.push(`changed paths outside the write scope: ${outside.join(", ")}`);
  if (deniedPaths(input.changedPaths).length > 0) failed.push("a changed path is on the credential denylist");
  return failed;
}
