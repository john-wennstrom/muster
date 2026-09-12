import type { ParsedTask } from "./task-parser.ts";
import { HarnessError } from "../shared/errors.ts";

export type TaskClaim = "completed" | "blocked" | "awaiting_user" | "design_conflict";

export interface DesignConflictEvidence {
  evidence: readonly string[];
  affectedArtifacts: readonly string[];
  affectedTasks: readonly string[];
  recommendation?: string;
}

export interface TaskOutcomeInput {
  taskId: string;
  claim: TaskClaim;
  implementationPersisted: boolean;
  verificationPassed: boolean;
  taskReviewApproved: boolean;
  evidencePersisted: boolean;
  reason?: string;
  checkpointId?: string;
  conflict?: DesignConflictEvidence;
}

export type EvaluatedTaskOutcome = {
  status: TaskClaim;
  taskId: string;
  reason?: string;
  synchronizeCheckbox: boolean;
  invalidatePlanningReview: boolean;
  blockAffectedBranch: boolean;
  checkpointId?: string;
  evidence?: readonly string[];
  affectedArtifacts?: readonly string[];
  affectedTasks?: readonly string[];
  recommendation?: string;
};

function invalidOutcome(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("TASK_OUTCOME_INVALID", message, details);
}

function blocked(taskId: string, reason: string): EvaluatedTaskOutcome {
  return {
    status: "blocked",
    taskId,
    reason,
    synchronizeCheckbox: false,
    invalidatePlanningReview: false,
    blockAffectedBranch: true,
  };
}

export function evaluateTaskOutcome(input: TaskOutcomeInput): EvaluatedTaskOutcome {
  if (!input.taskId.trim()) invalidOutcome("Task outcome requires a task identifier", {});

  if (input.claim === "completed") {
    if (!input.implementationPersisted) return blocked(input.taskId, "implementation result is not persisted");
    if (!input.verificationPassed) return blocked(input.taskId, "required verification has not passed");
    if (!input.taskReviewApproved) return blocked(input.taskId, "task review is not approved");
    if (!input.evidencePersisted) return blocked(input.taskId, "completion evidence is not persisted");
    return {
      status: "completed",
      taskId: input.taskId,
      synchronizeCheckbox: true,
      invalidatePlanningReview: false,
      blockAffectedBranch: false,
    };
  }

  if (!input.evidencePersisted) {
    return blocked(input.taskId, `${input.claim} evidence is not persisted`);
  }
  if (input.claim === "blocked") {
    if (!input.reason?.trim()) invalidOutcome("Blocked task outcome requires a reason", { taskId: input.taskId });
    return blocked(input.taskId, input.reason.trim());
  }
  if (input.claim === "awaiting_user") {
    if (!input.reason?.trim() || !input.checkpointId?.trim()) {
      invalidOutcome("Awaiting-user outcome requires a reason and checkpoint", { taskId: input.taskId });
    }
    return {
      status: "awaiting_user",
      taskId: input.taskId,
      reason: input.reason.trim(),
      checkpointId: input.checkpointId.trim(),
      synchronizeCheckbox: false,
      invalidatePlanningReview: false,
      blockAffectedBranch: true,
    };
  }

  const conflict = input.conflict;
  if (
    !conflict ||
    conflict.evidence.length === 0 ||
    conflict.affectedArtifacts.length === 0 ||
    conflict.affectedTasks.length === 0
  ) {
    invalidOutcome("Design-conflict outcome requires evidence, artifacts, and affected tasks", {
      taskId: input.taskId,
    });
  }
  return {
    status: "design_conflict",
    taskId: input.taskId,
    synchronizeCheckbox: false,
    invalidatePlanningReview: true,
    blockAffectedBranch: true,
    evidence: [...conflict.evidence],
    affectedArtifacts: [...conflict.affectedArtifacts],
    affectedTasks: [...conflict.affectedTasks],
    recommendation: conflict.recommendation,
  };
}

export function synchronizeTaskCheckbox(
  contents: string,
  task: ParsedTask,
  outcome: EvaluatedTaskOutcome,
): string {
  if (
    outcome.status !== "completed" ||
    !outcome.synchronizeCheckbox ||
    outcome.taskId !== task.checkboxId
  ) {
    throw new HarnessError(
      "TASK_COMPLETION_INVALID",
      `Task ${task.checkboxId} cannot be synchronized without accepted completion evidence`,
      { taskId: task.checkboxId, outcome },
    );
  }
  if (task.checked) return contents;
  const start = task.location.checkbox.start.offset;
  const end = task.location.checkbox.end.offset;
  if (start === undefined || end === undefined) {
    throw new HarnessError(
      "TASK_COMPLETION_INVALID",
      `Task ${task.checkboxId} has no source offsets for synchronization`,
      { taskId: task.checkboxId, location: task.location.checkbox },
    );
  }
  const taskSource = contents.slice(start, end);
  const checkboxOffset = taskSource.indexOf("[ ]");
  if (checkboxOffset === -1 || taskSource.indexOf("[ ]", checkboxOffset + 3) !== -1) {
    throw new HarnessError(
      "TASK_COMPLETION_INVALID",
      `Task ${task.checkboxId} source checkbox is missing or ambiguous`,
      { taskId: task.checkboxId, location: task.location.checkbox },
    );
  }
  const absoluteOffset = start + checkboxOffset;
  return `${contents.slice(0, absoluteOffset)}[x]${contents.slice(absoluteOffset + 3)}`;
}