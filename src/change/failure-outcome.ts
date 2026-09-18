import { HarnessError } from "../shared/errors.ts";
import type { CommandOutcome } from "./command.ts";
import { classifyFailure, failureCodeOf } from "./failure-classification.ts";
import type { ParsedChangeCommand } from "./parse.ts";

const MAX_MESSAGE_LENGTH = 2_000;

/** Converts a raised failure into the outcome its declared classification calls for. */
export function terminalErrorOutcome(
  error: unknown,
  parsed: ParsedChangeCommand | null,
): CommandOutcome {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE_LENGTH);
  const code = failureCodeOf(error);
  const classification = classifyFailure(code);
  const action = parsed?.action ?? "status";

  const aborted = error instanceof DOMException && error.name === "AbortError";
  if (aborted || classification.cancelled) {
    return {
      status: "cancelled",
      action,
      changeName: parsed?.changeName,
      code,
      summary: `/change cancelled: ${message}`,
      next: parsed?.changeName ? `/change status ${parsed.changeName}` : undefined,
    };
  }

  const kind = classification.blocker;
  const checkpointIds = error instanceof HarnessError && typeof error.details.checkpointId === "string"
    ? [error.details.checkpointId]
    : undefined;
  const next = kind === "pending_checkpoint" && parsed?.changeName
    ? `/change resume ${parsed.changeName} <checkpoint-id>`
    : code === "CHANGE_NOT_FOUND" && parsed?.changeName
      ? `/change propose ${parsed.changeName}`
      : parsed?.changeName
        ? `/change status ${parsed.changeName}`
        : undefined;

  return {
    status: kind ? "blocked" : "failure",
    action,
    changeName: parsed?.changeName,
    code,
    summary: `/change ${kind ? "blocked" : "failed"}: ${message}`,
    next,
    blocker: kind
      ? { kind, message, artifact: classification.artifact, checkpointIds }
      : undefined,
  };
}
