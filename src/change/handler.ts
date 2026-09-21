import type { ChangeAction } from "../controller/action-resolver.ts";
import type { ChangeSnapshot } from "../controller/change-snapshot.ts";
import type { Lane } from "../controller/lane.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../tools/command-profile.ts";
import { FALLBACK_ACTOR } from "../shared/actor.ts";
import type { AgentRunObserver } from "./agent-progress.ts";
import type { ChangeCommandContext } from "./context.ts";
import { extractLaneArgument, type ParsedChangeCommand } from "./parse.ts";
import { acceptsArity, changeCommands, type ChangeCommandSpec } from "./commands.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "./command.ts";
import { changeStateQuery } from "./command.ts";
import { loadProductionChangeSnapshot } from "./snapshot.ts";

const DEFAULT_ACTOR = FALLBACK_ACTOR;

type ChangeNameFor<A extends ChangeAction> =
  (typeof changeCommands)[A]["change"] extends "required" ? string
    : (typeof changeCommands)[A]["change"] extends "none" ? undefined
      : string | undefined;

export interface ChangeHandlerRequest<A extends ChangeAction = ChangeAction> {
  action: A;
  changeName: ChangeNameFor<A>;
  /** The raw argument remainder, already split on whitespace. */
  args: readonly string[];
  /** The same remainder rejoined and trimmed, without any `lane=` word; empty when the action took no free text. */
  prompt: string;
  /** The lane the user asked for with `lane=`, for actions that accept one. */
  lane?: Lane;
  cwd: string;
  signal?: AbortSignal;
  runId?: string;
  onAgentStart?: AgentRunObserver;
  actor: string;
  options: ProductionRuntimeOptions;
  /** Loads the change snapshot at most once per invocation. */
  snapshot(): Promise<ChangeSnapshot | null>;
}

/** A handler's own result; the shared contract attaches the action and change name. */
export type ChangeHandlerResult = Omit<CommandOutcome, "action" | "changeName">;

export type ChangeHandler = (
  command: ParsedChangeCommand & { changeName?: string },
  context: ChangeCommandContext,
) => Promise<CommandOutcome | void>;

function usageOutcome(action: ChangeAction, changeName?: string): CommandOutcome {
  const spec = changeCommands[action];
  return {
    status: "blocked",
    action,
    changeName,
    summary: [`Usage: ${spec.usage}`, HOST_EXECUTION_SECURITY_NOTICE].join("\n"),
    next: spec.usage,
  };
}

/**
 * Builds a `/change` handler factory that normalizes the invocation once, so handlers
 * interpret arguments and call one phase without restating the shared plumbing.
 */
export function defineChangeHandler<A extends ChangeAction>(
  action: A,
  run: (request: ChangeHandlerRequest<A>) => Promise<ChangeHandlerResult>,
): (cwd: string, options: ProductionRuntimeOptions) => ChangeHandler {
  const spec = changeCommands[action];
  return (cwd, options) => async (command, context) => {
    if (spec.change === "required" && !command.changeName) return usageOutcome(action);
    if (!acceptsArity(spec, command.arguments.length)) return usageOutcome(action, command.changeName);

    const laneArgument = (spec as ChangeCommandSpec).laneOption ? extractLaneArgument(command.arguments) : undefined;
    if (laneArgument?.kind === "invalid") return usageOutcome(action, command.changeName);
    const args = laneArgument ? laneArgument.rest : command.arguments;

    let snapshot: Promise<ChangeSnapshot | null> | undefined;
    const result = await run({
      action,
      changeName: command.changeName as ChangeNameFor<A>,
      args,
      prompt: args.join(" ").trim(),
      ...(laneArgument?.kind === "lane" ? { lane: laneArgument.lane } : {}),
      cwd,
      signal: options.signal ?? context.signal,
      runId: context.run?.runId,
      onAgentStart: context.onAgentStart ?? options.onAgentStart,
      actor: context.actor ?? DEFAULT_ACTOR,
      options,
      snapshot() {
        snapshot ??= (options.ports?.loadSnapshot ?? loadProductionChangeSnapshot)(
          changeStateQuery(options, cwd, command.changeName!),
        );
        return snapshot;
      },
    });
    return { ...result, action, changeName: command.changeName };
  };
}
