import { describe, expect, test } from "bun:test";
import { classifyChange } from "../../src/controller/complexity-router.ts";
import {
  mergeRiskInputs,
  patternRiskInputs,
  type RiskInputs,
} from "../../src/controller/complexity-inputs.ts";
import type { PlanningPhase } from "../../src/controller/planning.ts";

/** The expressions exactly as they were written inline in the planning phase. */
function originalExpressions(prompt: string, phase: PlanningPhase): RiskInputs {
  return {
    hasPublicContractChange: /\b(?:public contract|api|schema|protocol)\b/i.test(prompt),
    hasDataMigration: /\bmigrat(?:e|ion)\b/i.test(prompt),
    hasSecurityBoundaryChange: /\b(?:security|permission|auth)\b/i.test(prompt),
    hasDesignAmbiguity: phase === "refine" && /\b(?:ambiguous|trade-?off|uncertain)\b/i.test(prompt),
  };
}

const prompts = [
  "",
  "Add a search box to the toolbar",
  // Known false positive: the request avoids a migration and still matches the pattern.
  "don't migrate the data, just add a column",
  // Known false negative: a wire format change matches none of the patterns.
  "change the wire format between the broker and the child",
  "Rename an internal function signature in the parser",
  "Change the public contract of the REST API",
  "Update the JSON schema and the protocol version",
  "Tighten permission checks around auth tokens for security",
  "There is a trade-off here and the requirement is ambiguous",
  "This is uncertain; consider the tradeoff",
  "Database Migration for the users table",
  "APIs are fine but Authority is not", // word boundaries: "apis" and "authority" must not match
];

const none: RiskInputs = {
  hasPublicContractChange: false,
  hasDataMigration: false,
  hasSecurityBoundaryChange: false,
  hasDesignAmbiguity: false,
};

describe("patternRiskInputs", () => {
  for (const phase of ["propose", "refine"] as const) {
    test(`equals the original expressions over the prompt table in ${phase}`, () => {
      for (const prompt of prompts) {
        expect(patternRiskInputs(prompt, phase)).toEqual(originalExpressions(prompt, phase));
      }
    });
  }

  test("reproduces both known failure prompts", () => {
    expect(patternRiskInputs("don't migrate the data, just add a column", "propose").hasDataMigration).toBe(true);
    expect(patternRiskInputs("change the wire format between the broker and the child", "propose"))
      .toEqual(none);
  });

  test("design ambiguity is only ever true in refinement", () => {
    const prompt = "this is ambiguous";
    expect(patternRiskInputs(prompt, "propose").hasDesignAmbiguity).toBe(false);
    expect(patternRiskInputs(prompt, "refine").hasDesignAmbiguity).toBe(true);
  });
});

describe("mergeRiskInputs", () => {
  const pattern: RiskInputs = {
    hasPublicContractChange: true,
    hasDataMigration: false,
    hasSecurityBoundaryChange: true,
    hasDesignAmbiguity: false,
  };

  test("with nothing judged, returns the pattern values", () => {
    expect(mergeRiskInputs(pattern, {}, "refine")).toEqual(pattern);
  });

  test("a confident no clears a pattern yes", () => {
    expect(mergeRiskInputs(pattern, { hasPublicContractChange: false }, "propose").hasPublicContractChange)
      .toBe(false);
  });

  test("a confident yes sets a pattern no", () => {
    expect(mergeRiskInputs(pattern, { hasDataMigration: true }, "propose").hasDataMigration).toBe(true);
  });

  test("an uncertain signal takes its pattern value and siblings are unaffected", () => {
    const merged = mergeRiskInputs(pattern, { hasDataMigration: true, hasPublicContractChange: false }, "propose");
    expect(merged).toEqual({
      hasPublicContractChange: false,
      hasDataMigration: true,
      hasSecurityBoundaryChange: true, // uncertain: the pattern value
      hasDesignAmbiguity: false,
    });
  });

  test("judged design ambiguity is ignored outside refinement", () => {
    expect(mergeRiskInputs(pattern, { hasDesignAmbiguity: true }, "propose").hasDesignAmbiguity).toBe(false);
  });

  test("judged design ambiguity is applied in refinement, in both directions", () => {
    expect(mergeRiskInputs(pattern, { hasDesignAmbiguity: true }, "refine").hasDesignAmbiguity).toBe(true);
    const ambiguous = { ...pattern, hasDesignAmbiguity: true };
    expect(mergeRiskInputs(ambiguous, { hasDesignAmbiguity: false }, "refine").hasDesignAmbiguity).toBe(false);
  });

  test("the same merged inputs classify identically however they were produced", () => {
    const viaMerge = mergeRiskInputs(none, { hasDataMigration: true }, "propose");
    const direct = { ...none, hasDataMigration: true };
    const files = { affectedFiles: ["src/a/x.ts"], affectedCapabilities: ["a"] };
    expect(classifyChange({ ...files, ...viaMerge })).toEqual(classifyChange({ ...files, ...direct }));
  });

  test("an override is applied and audited unchanged whatever the judged inputs are", () => {
    const files = { affectedFiles: ["src/a/x.ts"], affectedCapabilities: ["a"] };
    const override = { classification: "bounded" as const, reason: "  Reviewed by hand.  ", actor: "user" as const };
    const viaPattern = classifyChange({ ...files, ...none }, override);
    const viaJudgment = classifyChange(
      { ...files, ...mergeRiskInputs(none, { hasDataMigration: true, hasSecurityBoundaryChange: true }, "propose") },
      override,
    );
    for (const decision of [viaPattern, viaJudgment]) {
      expect(decision.classification).toBe("bounded");
      expect(decision.override).toEqual({ ...override, reason: "Reviewed by hand." });
      expect(decision.reason).toBe(`user override from ${decision.computedClassification} to bounded: Reviewed by hand.`);
    }
    expect(() => classifyChange({ ...files, ...none }, { ...override, reason: "  " })).toThrow();
  });
});
