import type { ChangeAction } from "../controller/action-resolver.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../tools/command-profile.ts";
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
