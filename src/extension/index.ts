import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFusionHarness from "../../extensions/fusion-harness/fusion-harness.ts";

export { registerFusionHarness };

export const changeSubcommands = [
  "explore",
  "propose",
  "refine",
  "review",
  "implement",
  "verify",
  "finish",
  "status",
  "resume",
] as const;

export default function registerMuster(pi: ExtensionAPI): void {
  registerFusionHarness(pi);
  pi.registerCommand("change", {
    description: "OpenSpec-driven change workflows (implementation in progress).",
    handler: async (_args, context) => {
      context.ui.notify(
        `muster beta: /change workflows are not implemented yet. Planned subcommands: ${changeSubcommands.join(", ")}.`,
        "info",
      );
    },
  });
}