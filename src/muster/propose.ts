import { runProductionPlanning } from "../runtime/planning.ts";
import type { ParsedChangeCommand, ChangeCommandContext } from "../runtime/change-command.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "../runtime/command.ts";

/** Builds the `/change propose` handler bound to the given cwd/options closure. */
export function createProposeHandler(cwd: string, options: ProductionRuntimeOptions) {
  return async function proposeHandler(
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ): Promise<CommandOutcome | void> {
    if (!command.changeName) {
      return {
        status: "blocked" as const,
        action: "propose" as const,
        summary: "Usage: /change propose <change> <goal>",
        next: "/change propose <change> <goal>",
      };
    }
    return (options.runners?.planning ?? runProductionPlanning)({
      cwd,
      changeName: command.changeName,
      phase: "propose",
      onAgentStart: context.onAgentStart ?? options.onAgentStart,
      runId: context.run?.runId,
      prompt: command.arguments.join(" ").trim(),
      signal: options.signal,
      argv: options.argv,
    });
  };
}
