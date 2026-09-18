import { runProductionImplementation } from "../runtime/implementation.ts";
import type { ParsedChangeCommand, ChangeCommandContext } from "../runtime/change-command.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "../runtime/command.ts";
import { loadProductionChangeSnapshot } from "../runtime/snapshot.ts";

/** Builds the `/change resume` handler bound to the given cwd/options closure. */
export function createResumeHandler(cwd: string, options: ProductionRuntimeOptions) {
  return async function resumeHandler(
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ): Promise<CommandOutcome | void> {
    const snapshot = await (options.ports?.loadSnapshot ?? loadProductionChangeSnapshot)({
      ...options,
      cwd,
      changeName: command.changeName!,
    });
    return (options.runners?.implementation ?? runProductionImplementation)({
      cwd,
      changeName: command.changeName!,
      reviewFreshness: snapshot?.freshness.review ?? "missing",
      checkpointId: command.arguments[0]!,
      onAgentStart: context.onAgentStart ?? options.onAgentStart,
      confirmedBy: context.actor ?? "local-user",
      signal: options.signal,
      argv: options.argv,
    });
  };
}
