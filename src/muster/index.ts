import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFusionHarness from "../../extensions/fusion-harness/fusion-harness.ts";
import {
  changeSubcommands,
  registerChangeCommand,
  type ChangeCommandDependencies,
} from "./change-command.ts";
import { createProductionChangeCommandDependencies } from "./production-runtime.ts";

export { registerFusionHarness };
export { changeSubcommands };

export default function registerMuster(
  pi: ExtensionAPI,
  dependencies?: ChangeCommandDependencies,
): void {
  const resolvedDependencies = dependencies ?? createProductionChangeCommandDependencies();
  registerFusionHarness(pi, { changeController: resolvedDependencies });
  registerChangeCommand(pi, resolvedDependencies);
}