import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveActor } from "../shared/actor.ts";
import { createAgentProgress } from "./agent-progress.ts";
import { MUSTER_CUSTOM_TYPE, musterChangeDetails, type MusterChangeDetails } from "./branding.ts";
import { renderCommandOutcome } from "./command.ts";
import type { ChangeCommandContext, ChangeCommandDependencies } from "./context.ts";
import { dispatchChangeCommand } from "./dispatch.ts";
import { terminalErrorOutcome } from "./failure-outcome.ts";
import { emitOutcome } from "./outcome.ts";
import { changeCommandDescription, parseChangeCommand } from "./parse.ts";
import { renderMusterChangePanel } from "./transcript.ts";

export function registerChangeCommand(
  pi: Pick<ExtensionAPI, "registerCommand" | "sendMessage">
    & Partial<Pick<ExtensionAPI, "registerMessageRenderer">>,
  dependencies: ChangeCommandDependencies,
): void {
  pi.registerMessageRenderer?.<MusterChangeDetails>(
    MUSTER_CUSTOM_TYPE,
    (message, _options, theme) => renderMusterChangePanel(message, theme),
  );
  pi.registerCommand("change", {
    description: changeCommandDescription,
    handler: async (args, context) => {
      const typedContext: ChangeCommandContext = {
        ui: context.ui,
        cwd: context.cwd,
        signal: context.signal,
        actor: resolveActor(),
        sendMessage: (message) => pi.sendMessage<MusterChangeDetails>({
          customType: MUSTER_CUSTOM_TYPE,
          content: typeof message === "string" ? message : renderCommandOutcome(message),
          display: true,
          details: typeof message === "string" ? undefined : musterChangeDetails(message),
        }),
      };
      const progress = createAgentProgress({
        command: parseChangeCommand(args)?.action ?? "",
        ui: context.ui,
        sendMessage: typedContext.sendMessage!,
      });
      typedContext.onAgentStart = progress.observe;
      try {
        const invocationDependencies = await dependencies.forInvocation?.(typedContext) ?? dependencies;
        await dispatchChangeCommand(args, typedContext, invocationDependencies);
      } catch (error) {
        emitOutcome(typedContext, terminalErrorOutcome(error, parseChangeCommand(args)));
      } finally {
        progress.finish();
      }
    },
  });
}
