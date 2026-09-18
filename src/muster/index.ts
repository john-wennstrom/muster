import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFusionHarness from "../../extensions/fusion-harness/fusion-harness.ts";
import {
  changeSubcommands,
  registerChangeCommand,
  type ChangeCommandDependencies,
} from "../change/change-command.ts";
import {
  createProductionChangeCommandDependencies,
  type ProductionRuntimeOptions,
} from "../change/dependencies.ts";

export { registerFusionHarness };
export { changeSubcommands };

export default function registerMuster(
  pi: ExtensionAPI,
  dependencies?: ChangeCommandDependencies,
  productionOptions: ProductionRuntimeOptions = {},
): void {
  const resolvedDependencies = dependencies ?? createProductionChangeCommandDependencies(productionOptions);
  registerFusionHarness(pi, { changeController: resolvedDependencies });
  registerChangeCommand(pi, resolvedDependencies);
}
