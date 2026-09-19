import type { HarnessErrorCode } from "../shared/errors.ts";
import type { CommandBlocker } from "./command.ts";

export type BlockerKind = CommandBlocker["kind"];

export interface FailureClassification {
  /** `null` presents the failure plainly instead of as a blocked outcome. */
  blocker: BlockerKind | null;
  /** Named when a code always concerns one artifact, so the point of failure need not infer it. */
  artifact?: string;
  /** Cancellation is reported as cancelled, never as a failure or a blocker. */
  cancelled?: true;
}

/** Reserved for failures that carry no declared code, so every reported code is declared. */
export const UNRECOGNIZED_FAILURE = "UNEXPECTED_ERROR" satisfies HarnessErrorCode;

/**
 * Total over `HarnessErrorCode`: adding a code without classifying it, or classifying a
 * code that is not declared, fails typechecking.
 */
export const failureClassifications = {
  BUDGET_CONFIG_INVALID: { blocker: "invalid_evidence" },
  BUDGET_EXHAUSTED: { blocker: "lifecycle" },
  COMPLEXITY_OVERRIDE_INVALID: { blocker: "invalid_evidence" },

  CHANGE_IDENTIFIER_INVALID: { blocker: "invalid_change" },
  CHANGE_NOT_FOUND: { blocker: "invalid_change" },
  CHANGE_PATH_UNSAFE: { blocker: "invalid_change" },
  CHANGE_SLUG_COLLISION: { blocker: "invalid_change" },

  COPILOT_ADAPTER_REQUIRED: { blocker: "model_unavailable" },
  MODEL_UNAVAILABLE: { blocker: "model_unavailable" },
  OPENAI_REQUIRED: { blocker: "model_unavailable" },
  REVIEW_MODEL_UNAVAILABLE: { blocker: "model_unavailable" },

  MANUAL_CHECKPOINT_CONFIRMED: { blocker: "pending_checkpoint" },
  MANUAL_CHECKPOINT_INVALID: { blocker: "pending_checkpoint" },
  MANUAL_CHECKPOINT_MISMATCH: { blocker: "pending_checkpoint" },
  MANUAL_RESUME_INVALID: { blocker: "pending_checkpoint" },

  LIFECYCLE_TRANSITION_INVALID: { blocker: "lifecycle" },

  GIT_COMMAND_FAILED: { blocker: "external_capability" },
  GIT_OUTPUT_INVALID: { blocker: "external_capability" },
  OPENSPEC_CAPABILITY_MISSING: { blocker: "external_capability" },
  OPENSPEC_COMMAND_FAILED: { blocker: "external_capability" },
  OPENSPEC_INVALID_JSON: { blocker: "external_capability" },
  OPENSPEC_SCHEMA_INSTALL_FAILED: { blocker: "external_capability" },
  OPENSPEC_SCHEMA_MISMATCH: { blocker: "external_capability" },
  PROCESS_SPAWN_FAILED: { blocker: "external_capability" },
  PROCESS_TIMEOUT: { blocker: "external_capability" },
  WORKTREE_UNSAFE: { blocker: "external_capability" },

  PERSISTENCE_CORRUPT_RECORD: { blocker: "invalid_evidence" },
  PERSISTENCE_PATH_INVALID: { blocker: "invalid_evidence" },
  PERSISTENCE_UNSUPPORTED_VERSION: { blocker: "invalid_evidence" },
  PERSISTENCE_VERSION_INVALID: { blocker: "invalid_evidence" },
  RECOVERY_STATE_CONFLICT: { blocker: "invalid_evidence" },
  SNAPSHOT_INCONSISTENT: { blocker: "invalid_evidence" },
  STATE_OBSERVATION_CONFLICT: { blocker: "invalid_evidence" },
  DEBUGGING_STATE_INVALID: { blocker: "invalid_evidence" },

  PLANNING_ARTIFACT_INVALID: { blocker: "invalid_evidence" },
  REVIEW_ARTIFACT_INVALID: { blocker: "invalid_evidence", artifact: "review.md" },
  VERIFICATION_ARTIFACT_INVALID: { blocker: "invalid_evidence", artifact: "verification.md" },
  VERIFICATION_NOT_READY: { blocker: "invalid_evidence", artifact: "verification.md" },
  TASK_DOCUMENT_INVALID: { blocker: "invalid_evidence", artifact: "tasks.md" },
  TASK_METADATA_INVALID: { blocker: "invalid_evidence", artifact: "tasks.md" },
  TASK_DAG_INVALID: { blocker: "invalid_evidence", artifact: "tasks.md" },
  TASK_DAG_IMMUTABLE: { blocker: "invalid_evidence", artifact: "tasks.md" },
  TASK_COMPLETION_INVALID: { blocker: "invalid_evidence" },
  TASK_OUTCOME_INVALID: { blocker: "invalid_evidence" },
  TASK_SCHEDULER_INVALID: { blocker: "invalid_evidence" },

  PROCESS_CANCELLED: { blocker: null, cancelled: true },

  // Internal faults and agent failures: nothing the user can satisfy, so no blocker.
  COMMAND_HANDLER_MISSING: { blocker: null },
  EXPLORE_AGENT_FAILED: { blocker: null },
  JUDGMENT_QUESTION_INVALID: { blocker: null },
  PLANNING_AGENT_FAILED: { blocker: null },
  REVIEW_TOOL_DENIED: { blocker: null },
  UNEXPECTED_ERROR: { blocker: null },
} as const satisfies Record<HarnessErrorCode, FailureClassification>;

export function isHarnessErrorCode(value: unknown): value is HarnessErrorCode {
  return typeof value === "string" && Object.hasOwn(failureClassifications, value);
}

/** The declared code an error reports, falling back to the reserved unrecognized code. */
export function failureCodeOf(error: unknown): HarnessErrorCode {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return isHarnessErrorCode(code) ? code : UNRECOGNIZED_FAILURE;
}

export function classifyFailure(code: HarnessErrorCode): FailureClassification {
  return failureClassifications[code];
}
