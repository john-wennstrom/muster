import type { ParsedTask } from "./task-parser.ts";
import type { TddEvidenceRecord } from "../persistence/records.ts";
import { runFreshRoleTask, type FreshRoleTaskRequest } from "../agents/role-runner.ts";
import { evaluateTddPolicy } from "../policies/tdd.ts";
import { HarnessError } from "../shared/errors.ts";
import type { BudgetAmount, BudgetEvaluator } from "../telemetry/budget.ts";

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
  behaviorChanging?: boolean;
  requirements?: readonly string[];
  scenarios?: readonly string[];
  tddEvidence?: TddEvidenceRecord;
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

export interface TaskPipelineBuilderResult {
  claim: TaskClaim;
  implementationPersisted: boolean;
  tddEvidence?: TddEvidenceRecord;
  reason?: string;
  /** What the builder says it changed, kept with a failure so the next attempt can see it. */
  statedFix?: string;
  checkpointId?: string;
  conflict?: DesignConflictEvidence;
}

export interface TaskPipelineVerificationResult {
  passed: boolean;
  evidence: readonly string[];
  /** The command that failed, present only when verification did not pass. */
  failure?: { command: string; exitCode: number | null; output: string };
}

export interface TaskPipelineReviewResult {
  approved: boolean;
  findings: readonly string[];
  /** Present when no reviewer ran and a judgment decision approved the task instead. */
  skipped?: { decisionRecordId: string };
}

export interface TaskPipelineOptions {
  runId: string;
  sessionsRoot: string;
  contents: string;
  task: ParsedTask;
  behaviorChanging: boolean;
  requirements: readonly string[];
  scenarios: readonly string[];
  reviewBudgetAvailable: boolean;
  budget?: BudgetEvaluator;
  verificationBudgetEstimate?: BudgetAmount;
  reviewBudgetEstimate?: BudgetAmount;
  runBuilder: (request: FreshRoleTaskRequest) => Promise<TaskPipelineBuilderResult>;
  runVerification: (
    builder: TaskPipelineBuilderResult,
  ) => Promise<TaskPipelineVerificationResult>;
  runReview: (input: {
    builder: TaskPipelineBuilderResult;
    verification: TaskPipelineVerificationResult;
  }) => Promise<TaskPipelineReviewResult>;
  persistEvidence: (input: {
    builder: TaskPipelineBuilderResult;
    verification: TaskPipelineVerificationResult;
    review: TaskPipelineReviewResult;
  }) => Promise<void>;
}

export interface TaskPipelineResult {
  outcome: EvaluatedTaskOutcome;
  contents: string;
  builderSessionId: string;
}

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
    const tdd = evaluateTddPolicy({
      taskId: input.taskId,
      behaviorChanging: input.behaviorChanging ?? false,
      requirements: input.requirements ?? [],
      scenarios: input.scenarios ?? [],
      evidence: input.tddEvidence,
    });
    if (!tdd.accepted) return blocked(input.taskId, tdd.reason!);
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

function pipelineBlocked(
  taskId: string,
  reason: string,
): EvaluatedTaskOutcome {
  return evaluateTaskOutcome({
    taskId,
    claim: "blocked",
    implementationPersisted: false,
    verificationPassed: false,
    taskReviewApproved: false,
    evidencePersisted: true,
    reason,
  });
}

function mandatoryBudgetReason(gate: "tests" | "review", reason: string): string {
  return `mandatory task ${gate} budget is unavailable: ${reason}`;
}

export async function runTaskPipeline(
  options: TaskPipelineOptions,
): Promise<TaskPipelineResult> {
  let builderSessionId = "";
  const builder = await runFreshRoleTask({
    runId: options.runId,
    taskId: options.task.checkboxId,
    role: "builder",
    sessionsRoot: options.sessionsRoot,
    prompt: `Implement task ${options.task.checkboxId}: ${options.task.description}`,
    execute: async (request) => {
      builderSessionId = request.sessionId;
      return options.runBuilder(request);
    },
  });

  if (builder.claim !== "completed") {
    const outcome = evaluateTaskOutcome({
      taskId: options.task.checkboxId,
      claim: builder.claim,
      implementationPersisted: builder.implementationPersisted,
      verificationPassed: false,
      taskReviewApproved: false,
      evidencePersisted: true,
      reason: builder.reason,
      checkpointId: builder.checkpointId,
      conflict: builder.conflict,
    });
    return { outcome, contents: options.contents, builderSessionId };
  }

  const tdd = evaluateTddPolicy({
    taskId: options.task.checkboxId,
    behaviorChanging: options.behaviorChanging,
    requirements: options.requirements,
    scenarios: options.scenarios,
    evidence: builder.tddEvidence,
  });
  if (!tdd.accepted) {
    return {
      outcome: pipelineBlocked(options.task.checkboxId, tdd.reason!),
      contents: options.contents,
      builderSessionId,
    };
  }

  const verificationBudget = options.budget?.forecast({
    phase: "validation",
    role: "validator",
    taskId: options.task.checkboxId,
    activity: "tests",
    estimate: options.verificationBudgetEstimate ?? { totalTokens: 0, costUsd: 0 },
  });
  if (verificationBudget?.status === "blocked_mandatory") {
    return {
      outcome: pipelineBlocked(
        options.task.checkboxId,
        mandatoryBudgetReason("tests", verificationBudget.reason),
      ),
      contents: options.contents,
      builderSessionId,
    };
  }

  const verification = await options.runVerification(builder);
  if (!verification.passed) {
    const outcome = evaluateTaskOutcome({
      taskId: options.task.checkboxId,
      claim: "completed",
      implementationPersisted: builder.implementationPersisted,
      verificationPassed: false,
      taskReviewApproved: false,
      evidencePersisted: false,
      behaviorChanging: options.behaviorChanging,
      requirements: options.requirements,
      scenarios: options.scenarios,
      tddEvidence: builder.tddEvidence,
    });
    return { outcome, contents: options.contents, builderSessionId };
  }
  if (!options.reviewBudgetAvailable) {
    return {
      outcome: pipelineBlocked(
        options.task.checkboxId,
        "mandatory task review budget is unavailable",
      ),
      contents: options.contents,
      builderSessionId,
    };
  }
  const reviewBudget = options.budget?.forecast({
    phase: "validation",
    role: "reviewer",
    taskId: options.task.checkboxId,
    activity: "review",
    estimate: options.reviewBudgetEstimate ?? { totalTokens: 0, costUsd: 0 },
  });
  if (reviewBudget?.status === "blocked_mandatory") {
    return {
      outcome: pipelineBlocked(
        options.task.checkboxId,
        mandatoryBudgetReason("review", reviewBudget.reason),
      ),
      contents: options.contents,
      builderSessionId,
    };
  }

  const review = await options.runReview({ builder, verification });
  if (!review.approved) {
    return {
      outcome: pipelineBlocked(
        options.task.checkboxId,
        review.findings.join("; ") || "task review requires repair",
      ),
      contents: options.contents,
      builderSessionId,
    };
  }
  await options.persistEvidence({ builder, verification, review });
  const outcome = evaluateTaskOutcome({
    taskId: options.task.checkboxId,
    claim: "completed",
    implementationPersisted: builder.implementationPersisted,
    verificationPassed: true,
    taskReviewApproved: true,
    evidencePersisted: true,
    behaviorChanging: options.behaviorChanging,
    requirements: options.requirements,
    scenarios: options.scenarios,
    tddEvidence: builder.tddEvidence,
  });
  return {
    outcome,
    contents: synchronizeTaskCheckbox(options.contents, options.task, outcome),
    builderSessionId,
  };
}