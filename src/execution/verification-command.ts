import { HarnessError } from "../shared/errors.ts";

/** Splits a verification command into executable and arguments, rejecting shell metacharacters. */
export function parseVerificationCommand(command: string): { executable: string; args: string[] } {
  const args: string[] = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/[;&|<>`]/.test(character)) {
      throw new HarnessError("TASK_OUTCOME_INVALID", "Verification commands cannot contain shell operators", { command });
    }
    if (/\s/.test(character)) {
      if (token) {
        args.push(token);
        token = "";
      }
    } else token += character;
  }
  if (quote) throw new HarnessError("TASK_OUTCOME_INVALID", "Verification command has an unclosed quote", { command });
  if (token) args.push(token);
  const executable = args.shift();
  if (!executable) throw new HarnessError("TASK_OUTCOME_INVALID", "Verification command is empty", { command });
  return { executable, args };
}
