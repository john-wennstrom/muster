import {
  loadModelStack,
  synthesizeLegacyStack,
  type ModelSlot,
  type ModelStack,
} from "../../extensions/fusion-harness/modules/model-stack.ts";
import { readCliFlag } from "../shared/cli-flags.ts";

export type ModelRole = "architect" | "builder" | "reviewer" | "validator";

/** One environment override per role; `MUSTER_EXPLORE_MODEL` is kept as an architect alias. */
const ROLE_ENV: Readonly<Record<ModelRole, readonly string[]>> = {
  architect: ["MUSTER_ARCHITECT_MODEL", "MUSTER_EXPLORE_MODEL"],
  builder: ["MUSTER_BUILDER_MODEL"],
  reviewer: ["MUSTER_REVIEWER_MODEL"],
  validator: ["MUSTER_VALIDATOR_MODEL", "MUSTER_ARCHITECT_MODEL"],
};

/** The single declared fallback per role, reached only when nothing else is configured. */
const ROLE_FALLBACK: Readonly<Record<ModelRole, string>> = {
  architect: "anthropic/claude-fable-5",
  builder: "openai/gpt-5.6-sol",
  reviewer: "openai/gpt-5.6-sol",
  validator: "anthropic/claude-fable-5",
};

export function roleEnvOverride(role: ModelRole, env: NodeJS.ProcessEnv = process.env): string {
  for (const name of ROLE_ENV[role]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function withModel(slot: ModelSlot, model: string): ModelSlot {
  return slot.model === model ? slot : { ...slot, model };
}

function applyOverrides(stack: ModelStack, env: NodeJS.ProcessEnv): ModelStack {
  const architectModel = roleEnvOverride("architect", env);
  const builderModel = roleEnvOverride("builder", env);
  if (!architectModel && !builderModel) return stack;
  const architect = architectModel ? withModel(stack.architect, architectModel) : stack.architect;
  const primaryBuilder = builderModel ? withModel(stack.primaryBuilder, builderModel) : stack.primaryBuilder;
  const remap = (slot: ModelSlot): ModelSlot =>
    slot === stack.architect ? architect : slot === stack.primaryBuilder ? primaryBuilder : slot;
  return {
    ...stack,
    slots: stack.slots.map(remap),
    builders: stack.builders.map(remap),
    architect,
    primaryBuilder,
  };
}

/**
 * Resolves every role's model with one precedence order: environment override, then the
 * configured model-stack slot, then the command-line flag, then the declared fallback.
 */
export function resolveModelStack(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ModelStack {
  const configPath = readCliFlag("fh-config", argv);
  const base = configPath
    ? loadModelStack(configPath)
    : synthesizeLegacyStack({
      architectModel: readCliFlag("architect", argv) || ROLE_FALLBACK.architect,
      builderModel: readCliFlag("builder", argv) || ROLE_FALLBACK.builder,
      architectThinking: "high",
      builderThinking: "high",
    });
  return applyOverrides(base, env);
}

export function roleModel(stack: ModelStack, role: ModelRole): string {
  switch (role) {
    case "architect":
    case "validator":
      return stack.architect.model;
    case "builder":
      return stack.primaryBuilder.model;
    case "reviewer":
      return stack.builders.find((slot) => slot.model !== stack.primaryBuilder.model)?.model
        ?? stack.primaryBuilder.model;
  }
}
