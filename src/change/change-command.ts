/**
 * The `/change` command surface's public entry points. Each responsibility lives in its
 * own module; this re-export keeps one stable import path for consumers.
 */
export { changeSubcommands } from "./commands.ts";
export {
  actionUsage,
  changeCommandDescription,
  changeResumeUsage,
  changeUsage,
  parseChangeCommand,
  type ParsedChangeCommand,
} from "./parse.ts";
export type {
  ChangeCommandContext,
  ChangeCommandDependencies,
  ChangeCommandHandler,
} from "./context.ts";
export {
  dispatchChangeCommand,
  dispatchLegacyChangeCommand,
  legacyCommandGuidance,
  type LegacyChangeCommand,
} from "./dispatch.ts";
export { emitOutcome, lifecycleBlocker, renderChangeStatus } from "./outcome.ts";
export { terminalErrorOutcome } from "./failure-outcome.ts";
export { registerChangeCommand } from "./register.ts";
