import type { PlanningPhase } from "./planning.ts";

/** The four risk booleans the complexity classifier accepts from a planning request. */
export interface RiskInputs {
  hasPublicContractChange: boolean;
  hasDataMigration: boolean;
  hasSecurityBoundaryChange: boolean;
  hasDesignAmbiguity: boolean;
}

/** The subset of the inputs that judgment was confident about; an absent key is uncertain. */
export type JudgedRiskInputs = Partial<RiskInputs>;

export function patternRiskInputs(prompt: string, phase: PlanningPhase): RiskInputs {
  return {
    hasPublicContractChange: /\b(?:public contract|api|schema|protocol)\b/i.test(prompt),
    hasDataMigration: /\bmigrat(?:e|ion)\b/i.test(prompt),
    hasSecurityBoundaryChange: /\b(?:security|permission|auth)\b/i.test(prompt),
    hasDesignAmbiguity: phase === "refine" && /\b(?:ambiguous|trade-?off|uncertain)\b/i.test(prompt),
  };
}

/**
 * A confident judged value replaces the pattern value for that one input; every other input
 * keeps its pattern value. Design ambiguity is applied only in refinement, as the pattern is,
 * because applying it to a proposal would trigger architectural orchestration in cases the
 * pattern never could.
 */
export function mergeRiskInputs(
  pattern: RiskInputs,
  judged: JudgedRiskInputs,
  phase: PlanningPhase,
): RiskInputs {
  return {
    hasPublicContractChange: judged.hasPublicContractChange ?? pattern.hasPublicContractChange,
    hasDataMigration: judged.hasDataMigration ?? pattern.hasDataMigration,
    hasSecurityBoundaryChange: judged.hasSecurityBoundaryChange ?? pattern.hasSecurityBoundaryChange,
    hasDesignAmbiguity: phase === "refine"
      ? judged.hasDesignAmbiguity ?? pattern.hasDesignAmbiguity
      : pattern.hasDesignAmbiguity,
  };
}
