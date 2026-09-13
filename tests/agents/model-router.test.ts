import { describe, expect, test } from "bun:test";
import {
  assertBetaProviderSupport,
  providerStatuses,
  routeFusionModel,
  routeModel,
  type ModelCapability,
} from "../../src/agents/model-router.ts";
import { synthesizeLegacyStack } from "../../extensions/fusion-harness/modules/model-stack.ts";

const candidates: ModelCapability[] = [
  {
    model: "openai/gpt-large",
    provider: "openai",
    available: true,
    authenticated: true,
    roles: ["architect", "builder", "reviewer", "validator"],
    contextTokens: 200_000,
    toolSupport: true,
    estimatedInputCostPerMillion: 2,
    adapter: "pi",
  },
  {
    model: "other/cheap",
    provider: "other",
    available: true,
    authenticated: true,
    roles: ["builder", "reviewer"],
    contextTokens: 100_000,
    toolSupport: true,
    estimatedInputCostPerMillion: 0.5,
    adapter: "pi",
  },
];

describe("model capability router", () => {
  test("routes by capability and cost while preferring a different review model", () => {
    expect(routeModel(candidates, {
      role: "builder",
      minimumContextTokens: 50_000,
      requiresTools: true,
    }).model).toBe("other/cheap");
    expect(routeModel(candidates, {
      role: "reviewer",
      minimumContextTokens: 50_000,
      requiresTools: true,
      preferDifferentFrom: "other/cheap",
    }).model).toBe("openai/gpt-large");
  });

  test("requires an authenticated available OpenAI model for beta checks", () => {
    expect(() => assertBetaProviderSupport(candidates)).not.toThrow();
    expect(() => assertBetaProviderSupport(candidates.map((candidate) => ({
      ...candidate,
      authenticated: candidate.provider === "openai" ? false : candidate.authenticated,
    })))).toThrow(/requires at least one.*OpenAI/);
  });

  test("reports Copilot unavailable without a real adapter", () => {
    const configured: ModelCapability[] = [...candidates, {
      model: "github-copilot/gpt",
      provider: "github-copilot",
      available: true,
      authenticated: true,
      roles: ["builder"],
      contextTokens: 100_000,
      toolSupport: true,
      estimatedInputCostPerMillion: null,
      adapter: "pi",
    }];

    expect(providerStatuses(configured)).toContainEqual({
      provider: "github-copilot",
      status: "unavailable",
      reason: "VS Code Copilot execution adapter is not installed",
    });
    expect(() => routeModel(configured.filter((candidate) => candidate.provider === "github-copilot"), {
      role: "builder",
      minimumContextTokens: 1,
      requiresTools: true,
    })).toThrow(/VS Code Copilot adapter/);
  });

  test("fails when context, tools, or budget remove every candidate", () => {
    expect(() => routeModel(candidates, {
      role: "validator",
      minimumContextTokens: 300_000,
      requiresTools: true,
      maximumInputCostPerMillion: 1,
    })).toThrow(/No eligible model/);
  });

  test("routes configured Fusion slots through the capability abstraction", () => {
    const stack = synthesizeLegacyStack({
      architectModel: "openai/gpt-large",
      builderModel: "other/cheap",
      architectThinking: "high",
      builderThinking: "medium",
    });
    const capabilities = Object.fromEntries(candidates.map(({ model, provider: _provider, ...capability }) => [model, capability]));

    expect(routeFusionModel(stack, capabilities, {
      role: "builder",
      minimumContextTokens: 10_000,
      requiresTools: true,
    }).model).toBe("other/cheap");
  });
});