import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  changeSubcommands,
  registerChangeCommand,
  type ChangeCommandDependencies,
} from "../change/change-command.ts";
import {
  createProductionChangeCommandDependencies,
  type ProductionRuntimeOptions,
} from "../change/dependencies.ts";

export { changeSubcommands };

/** The flags `/change` reads from the command line, registered so the host accepts them. */
const CHANGE_FLAGS = {
  "fh-config":
    "Explicit path to .pi/fusion-harness/model-stack-<codename>.yaml (2-5 slots, exactly one architect and one primary builder).",
  architect: "ARCHITECT model (provider/id) — plans and explores.",
  builder: "BUILDER model (provider/id) — builds.",
  "planning-max-tokens": "Token limit for the planning phase forecast of /change propose and refine. A positive number, or unlimited to disable the cap.",
  "planning-max-cost": "Cost limit in USD for the planning phase forecast of /change propose and refine. A positive number, or unlimited to disable the cap.",
} as const;

export default function registerMuster(
  pi: ExtensionAPI,
  dependencies?: ChangeCommandDependencies,
  productionOptions: ProductionRuntimeOptions = {},
): void {
  const resolvedDependencies = dependencies ?? createProductionChangeCommandDependencies(productionOptions);
  for (const [name, description] of Object.entries(CHANGE_FLAGS)) {
    pi.registerFlag(name, { type: "string", description });
  }
  registerChangeCommand(pi, resolvedDependencies);
}
