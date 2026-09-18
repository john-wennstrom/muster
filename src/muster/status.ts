import { renderChangeStatus } from "../runtime/change-command.ts";
import type { ParsedChangeCommand, ChangeCommandContext } from "../runtime/change-command.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "../runtime/command.ts";
import { loadProductionChangeSnapshot, loadProductionChangeUsage } from "../runtime/snapshot.ts";

/** Builds the `/change status` handler bound to the given cwd/options closure. */
export function createStatusHandler(cwd: string, options: ProductionRuntimeOptions) {
  return async function statusHandler(
    command: ParsedChangeCommand & { changeName?: string },
    _context: ChangeCommandContext,
  ): Promise<CommandOutcome | void> {
    const snapshot = await (options.ports?.loadSnapshot ?? loadProductionChangeSnapshot)({
      ...options,
      cwd,
      changeName: command.changeName!,
    });
    if (!snapshot) {
      return {
        status: "blocked" as const,
        action: "status" as const,
        changeName: command.changeName,
        summary: `Change ${command.changeName} does not have a readable production snapshot.`,
      };
    }
    const usage = await (options.ports?.loadUsage ?? loadProductionChangeUsage)({
      ...options,
      cwd,
      changeName: command.changeName!,
    });
    return {
      status: "success" as const,
      action: "status" as const,
      changeName: command.changeName,
      summary: renderChangeStatus(snapshot, usage),
    };
  };
}
