export type HarnessErrorCode =
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
  | "STATE_OBSERVATION_CONFLICT";

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