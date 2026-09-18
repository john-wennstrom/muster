import type { ChangeAction } from "../controller/action-resolver.ts";
import type { ChangeSnapshot } from "../controller/change-snapshot.ts";
import type { ChangeUsageSummary } from "../persistence/change-usage-store.ts";
import type { AgentRunObserver } from "./agent-progress.ts";
import type { CommandOutcome, CommandRunContext } from "./command.ts";
import type { ParsedChangeCommand } from "./parse.ts";

export interface ChangeCommandContext {
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  cwd?: string;
  signal?: AbortSignal;
  actor?: string;
  run?: CommandRunContext;
  onAgentStart?: AgentRunObserver;
  /**
   * Post durable content into the chat transcript. `ui.notify` is a transient toast
   * unsuited to long-form output; handlers that produce such content should prefer this
   * and fall back to `ui.notify` when it is unavailable (e.g. in tests). Passing the
   * outcome rather than rendered text lets the host attach structured details.
   */
  sendMessage?(message: CommandOutcome | string): void;
}

export type ChangeCommandHandler = (
  command: ParsedChangeCommand & { changeName?: string },
  context: ChangeCommandContext,
) => Promise<CommandOutcome | void>;

export interface ChangeCommandDependencies {
  forInvocation?(context: ChangeCommandContext): ChangeCommandDependencies | Promise<ChangeCommandDependencies>;
  createRunContext?(
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ): CommandRunContext | Promise<CommandRunContext>;
  resolveChangeName(explicit?: string, action?: ChangeAction): Promise<string | null>;
  activateChange?(changeName: string): Promise<void>;
  loadSnapshot(changeName: string): Promise<ChangeSnapshot | null>;
  loadChangeUsage?(changeName: string): Promise<ChangeUsageSummary | null>;
  handlers: Partial<Record<ChangeAction, ChangeCommandHandler>>;
}
