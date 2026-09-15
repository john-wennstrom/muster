import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFusionHarness from "../../extensions/fusion-harness/fusion-harness.ts";
import {
  changeSubcommands,
  registerChangeCommand,
  type ChangeCommandDependencies,
} from "./change-command.ts";

export { registerFusionHarness };
export { changeSubcommands };

export default function registerMuster(
  pi: ExtensionAPI,
  dependencies: ChangeCommandDependencies = {
    resolveChangeName: async (explicit) => explicit ?? null,
    loadSnapshot: async () => null,
    handlers: {},
  },
): void {
  registerFusionHarness(pi, { changeController: dependencies });
  registerChangeCommand(pi, dependencies);
}