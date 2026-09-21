import type { ChangeAction } from "../controller/action-resolver.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../tools/command-profile.ts";
import { isLane, type Lane } from "../controller/lane.ts";
import { changeCommandSpec, changeSubcommands, isChangeAction } from "./commands.ts";

export interface ParsedChangeCommand {
  action: ChangeAction;
  changeName?: string;
  arguments: readonly string[];
}

export const changeUsage = [
  `Usage: /change <${changeSubcommands.join("|")}> [change] [arguments]`,
  HOST_EXECUTION_SECURITY_NOTICE,
].join("\n");

export const changeResumeUsage = [
  `Usage: ${changeCommandSpec("resume").usage}`,
  HOST_EXECUTION_SECURITY_NOTICE,
].join("\n");

export const changeCommandDescription =
  `Correctness-ready beta OpenSpec workflows. ${HOST_EXECUTION_SECURITY_NOTICE}`;

export function actionUsage(action: ChangeAction): string {
  return [`Usage: ${changeCommandSpec(action).usage}`, HOST_EXECUTION_SECURITY_NOTICE].join("\n");
}

export function parseChangeCommand(raw: string): ParsedChangeCommand | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || !isChangeAction(parts[0]!)) return null;
  const action = parts[0];
  // A free-text action's whole remainder is its prompt — there is no change slug in it.
  if (changeCommandSpec(action).args === "free-text") {
    return { action, changeName: undefined, arguments: parts.slice(1) };
  }
  return { action, changeName: parts[1], arguments: parts.slice(2) };
}

export type LaneArgument =
  | { readonly kind: "none"; readonly rest: readonly string[] }
  | { readonly kind: "lane"; readonly lane: Lane; readonly rest: readonly string[] }
  | { readonly kind: "invalid"; readonly value: string };

/**
 * Takes `lane=<name>` off the front of a command's arguments. It is a plain argument word, not a
 * flag, and only the word right after the change name counts, so a goal that merely begins with
 * "small" or "lane" is never misread. An unrecognized lane name is reported, not passed on.
 */
export function extractLaneArgument(args: readonly string[]): LaneArgument {
  const first = args[0];
  if (first === undefined || !first.toLowerCase().startsWith("lane=")) return { kind: "none", rest: args };
  const value = first.slice("lane=".length);
  return isLane(value) ? { kind: "lane", lane: value, rest: args.slice(1) } : { kind: "invalid", value };
}
