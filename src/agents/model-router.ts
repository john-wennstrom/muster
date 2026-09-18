import type { ModelStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import type { HarnessErrorCode } from "../shared/errors.ts";
import type { UsageRole } from "../telemetry/usage.ts";

export interface ModelCapability {
  model: string;
  provider: string;
  available: boolean;
  authenticated: boolean;
  roles: readonly UsageRole[];
  contextTokens: number;
  toolSupport: boolean;
  estimatedInputCostPerMillion: number | null;
  adapter: "pi" | "vscode-copilot";
}

export interface ModelRouteRequest {
  role: UsageRole;
  minimumContextTokens: number;
  requiresTools: boolean;
  maximumInputCostPerMillion?: number;
  preferDifferentFrom?: string;
}

export interface ProviderStatus {
  provider: string;
  status: "available" | "unavailable";
  reason?: string;
}

export class ModelRoutingError extends Error {
  constructor(
    readonly code: Extract<HarnessErrorCode, "MODEL_UNAVAILABLE" | "OPENAI_REQUIRED" | "COPILOT_ADAPTER_REQUIRED">,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export function candidatesFromFusionStack(
  stack: ModelStack,
  capabilities: Readonly<Record<string, Omit<ModelCapability, "model" | "provider">>>,
): ModelCapability[] {
  return stack.slots.map((slot) => {
    const separator = slot.model.indexOf("/");
    const provider = separator > 0 ? slot.model.slice(0, separator) : "unknown";
    const capability = capabilities[slot.model] ?? {
      available: false,
      authenticated: false,
      roles: [] as UsageRole[],
      contextTokens: 0,
      toolSupport: false,
      estimatedInputCostPerMillion: null,
      adapter: "pi" as const,
    };
    return { model: slot.model, provider, ...capability };
  });
}

export function providerStatuses(
  candidates: readonly ModelCapability[],
  copilotAdapterInstalled = false,
): ProviderStatus[] {
  const providers = new Set(candidates.map((candidate) => candidate.provider));
  providers.add("github-copilot");
  return [...providers].sort().map((provider) => {
    if (provider === "github-copilot" && !copilotAdapterInstalled) {
      return {
        provider,
        status: "unavailable" as const,
        reason: "VS Code Copilot execution adapter is not installed",
      };
    }
    const available = candidates.some((candidate) =>
      candidate.provider === provider && candidate.available && candidate.authenticated &&
      (provider !== "github-copilot" || candidate.adapter === "vscode-copilot")
    );
    return {
      provider,
      status: available ? "available" as const : "unavailable" as const,
      reason: available ? undefined : "No authenticated model capability is available",
    };
  });
}

export function assertBetaProviderSupport(candidates: readonly ModelCapability[]): void {
  const openAiAvailable = candidates.some((candidate) =>
    candidate.provider === "openai" && candidate.available && candidate.authenticated
  );
  if (!openAiAvailable) {
    throw new ModelRoutingError(
      "OPENAI_REQUIRED",
      "Beta validation requires at least one available authenticated OpenAI model",
    );
  }
}

export function routeModel(
  candidates: readonly ModelCapability[],
  request: ModelRouteRequest,
): ModelCapability {
  const eligible = candidates.filter((candidate) =>
    candidate.available &&
    candidate.authenticated &&
    candidate.roles.includes(request.role) &&
    candidate.contextTokens >= request.minimumContextTokens &&
    (!request.requiresTools || candidate.toolSupport) &&
    (candidate.provider !== "github-copilot" || candidate.adapter === "vscode-copilot") &&
    (
      request.maximumInputCostPerMillion === undefined ||
      (candidate.estimatedInputCostPerMillion !== null && candidate.estimatedInputCostPerMillion <= request.maximumInputCostPerMillion)
    )
  );
  if (eligible.length === 0) {
    const copilotConfigured = candidates.some((candidate) => candidate.provider === "github-copilot");
    if (copilotConfigured && candidates.every((candidate) =>
      candidate.provider !== "github-copilot" || candidate.adapter !== "vscode-copilot"
    )) {
      throw new ModelRoutingError(
        "COPILOT_ADAPTER_REQUIRED",
        "GitHub Copilot child execution requires a VS Code Copilot adapter",
      );
    }
    throw new ModelRoutingError("MODEL_UNAVAILABLE", `No eligible model is available for ${request.role}`, { request });
  }
  return [...eligible].sort((left, right) => {
    const leftDifferent = left.model !== request.preferDifferentFrom ? 0 : 1;
    const rightDifferent = right.model !== request.preferDifferentFrom ? 0 : 1;
    if (leftDifferent !== rightDifferent) return leftDifferent - rightDifferent;
    const leftCost = left.estimatedInputCostPerMillion ?? Number.POSITIVE_INFINITY;
    const rightCost = right.estimatedInputCostPerMillion ?? Number.POSITIVE_INFINITY;
    return leftCost - rightCost || left.model.localeCompare(right.model);
  })[0]!;
}

export function routeFusionModel(
  stack: ModelStack,
  capabilities: Readonly<Record<string, Omit<ModelCapability, "model" | "provider">>>,
  request: ModelRouteRequest,
): ModelCapability {
  return routeModel(candidatesFromFusionStack(stack, capabilities), request);
}