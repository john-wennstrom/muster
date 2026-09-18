import { randomUUID } from "node:crypto";
import type { CommandOutcome } from "./command.ts";

/** The single custom message type tagging every transcript message and widget the `/change` surface emits. */
export const MUSTER_CUSTOM_TYPE = "muster-change";

export function musterWidgetKey(scope: string): string {
  return `${MUSTER_CUSTOM_TYPE}-${scope}-${randomUUID()}`;
}

/** Machine-readable payload carried alongside every `/change` transcript message. */
export type MusterChangeDetails = Pick<
  CommandOutcome,
  "action" | "changeName" | "status" | "runId" | "code"
>;

export function musterChangeDetails(outcome: CommandOutcome): MusterChangeDetails {
  return {
    action: outcome.action,
    changeName: outcome.changeName,
    status: outcome.status,
    runId: outcome.runId,
    code: outcome.code,
  };
}
