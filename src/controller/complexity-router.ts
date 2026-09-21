import { HarnessError } from "../shared/errors.ts";

export type ChangeComplexity = "direct" | "bounded" | "architectural";

export interface ComplexityInput {
  affectedFiles: readonly string[];
  affectedCapabilities: readonly string[];
  hasPublicContractChange: boolean;
  hasDataMigration: boolean;
  hasSecurityBoundaryChange: boolean;
  hasDesignAmbiguity: boolean;
}

export interface ComplexityOverride {
  classification: ChangeComplexity;
  reason: string;
  actor: "user" | "controller";
}

export interface ComplexitySignal {
  name: string;
  value: number | boolean;
  severity: "low" | "medium" | "high";
}

export interface ComplexityDecision {
  classification: ChangeComplexity;
  computedClassification: ChangeComplexity;
  reason: string;
  signals: readonly ComplexitySignal[];
  override?: ComplexityOverride;
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

function computedClassification(signals: readonly ComplexitySignal[]): ChangeComplexity {
  if (signals.some((signal) => signal.severity === "high")) return "architectural";
  if (signals.some((signal) => signal.severity === "medium")) return "bounded";
  return "direct";
}

export function classifyChange(
  input: ComplexityInput,
  override?: ComplexityOverride,
): ComplexityDecision {
  const fileCount = uniqueCount(input.affectedFiles);
  const capabilityCount = uniqueCount(input.affectedCapabilities);
  const signals: ComplexitySignal[] = [
    {
      name: "affected_file_count",
      value: fileCount,
      severity: fileCount <= 2 ? "low" : fileCount <= 8 ? "medium" : "high",
    },
    {
      name: "affected_capability_count",
      value: capabilityCount,
      severity: capabilityCount <= 1 ? "low" : capabilityCount === 2 ? "medium" : "high",
    },
    {
      name: "cross_capability",
      value: capabilityCount > 2,
      severity: capabilityCount > 2 ? "high" : capabilityCount === 2 ? "medium" : "low",
    },
    {
      name: "public_contract",
      value: input.hasPublicContractChange,
      severity: input.hasPublicContractChange ? "medium" : "low",
    },
    {
      name: "data_migration",
      value: input.hasDataMigration,
      severity: input.hasDataMigration ? "high" : "low",
    },
    {
      name: "security_boundary",
      value: input.hasSecurityBoundaryChange,
      severity: input.hasSecurityBoundaryChange ? "high" : "low",
    },
    {
      name: "design_ambiguity",
      value: input.hasDesignAmbiguity,
      severity: input.hasDesignAmbiguity ? "high" : "low",
    },
  ];
  const computed = computedClassification(signals);
  const baseReason = computed === "direct"
    ? `localized change across ${fileCount} file(s) and ${capabilityCount} capability.`
    : computed === "bounded"
      ? "Change has a contained multi-file, multi-capability, or public-contract impact."
      : "Change has cross-cutting, migration, security-boundary, or design-ambiguity risk.";

  if (override && !override.reason.trim()) {
    throw new HarnessError(
      "COMPLEXITY_OVERRIDE_INVALID",
      "Complexity overrides require an auditable non-empty reason",
      { classification: override.classification, actor: override.actor },
    );
  }

  return Object.freeze({
    classification: override?.classification ?? computed,
    computedClassification: computed,
    reason: override
      ? `${override.actor} override from ${computed} to ${override.classification}: ${override.reason.trim()}`
      : baseReason,
    signals: Object.freeze(signals.map((signal) => Object.freeze(signal))),
    override: override
      ? Object.freeze({ ...override, reason: override.reason.trim() })
      : undefined,
  });
}
