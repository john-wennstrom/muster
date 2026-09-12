export type HarnessErrorCode =
  | "COMPLEXITY_OVERRIDE_INVALID"
  | "GIT_COMMAND_FAILED"
  | "GIT_OUTPUT_INVALID"
  | "PROCESS_CANCELLED"
  | "PROCESS_SPAWN_FAILED"
  | "PROCESS_TIMEOUT"
  | "OPENSPEC_CAPABILITY_MISSING"
  | "OPENSPEC_COMMAND_FAILED"
  | "OPENSPEC_INVALID_JSON"
  | "OPENSPEC_SCHEMA_MISMATCH"
  | "PERSISTENCE_CORRUPT_RECORD"
  | "PERSISTENCE_PATH_INVALID"
  | "PERSISTENCE_UNSUPPORTED_VERSION"
  | "PERSISTENCE_VERSION_INVALID"
  | "RECOVERY_STATE_CONFLICT"
  | "REVIEW_ARTIFACT_INVALID"
  | "REVIEW_MODEL_UNAVAILABLE"
  | "REVIEW_TOOL_DENIED"
  | "LIFECYCLE_TRANSITION_INVALID"
  | "SNAPSHOT_INCONSISTENT"
  | "STATE_OBSERVATION_CONFLICT"
  | "TASK_DOCUMENT_INVALID"
  | "TASK_METADATA_INVALID"
  | "TASK_DAG_IMMUTABLE"
  | "TASK_DAG_INVALID"
  | "TASK_SCHEDULER_INVALID"
  | "TASK_COMPLETION_INVALID"
  | "TASK_OUTCOME_INVALID"
  | "WORKTREE_UNSAFE";

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: HarnessErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}