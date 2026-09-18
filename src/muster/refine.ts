import { runProductionPlanning } from "../runtime/planning.ts";
import type { ParsedChangeCommand, ChangeCommandContext } from "../runtime/change-command.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "../runtime/command.ts";

/** Builds the `/change refine` handler bound to the given cwd/options closure. */
export function createRefineHandler(cwd: string, options: ProductionRuntimeOptions) {
  return async function refineHandler(
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ): Promise<CommandOutcome | void> {
    return (options.runners?.planning ?? runProductionPlanning)({
      cwd,
      changeName: command.changeName!,
      phase: "refine",
      onAgentStart: context.onAgentStart ?? options.onAgentStart,
      runId: context.run?.runId,
      prompt: command.arguments.join(" ").trim(),
      signal: options.signal,
      argv: options.argv,
    });
  };
}
