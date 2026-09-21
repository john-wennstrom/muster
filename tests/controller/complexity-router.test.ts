import { describe, expect, test } from "bun:test";
import {
  classifyChange,
} from "../../src/controller/complexity-router.ts";
import { HarnessError } from "../../src/shared/errors.ts";

describe("change complexity router", () => {
  test("classifies localized low-risk work as direct with auditable signals", () => {
    const result = classifyChange({
      affectedFiles: ["src/review/parser.ts"],
      affectedCapabilities: ["review"],
      hasPublicContractChange: false,
      hasDataMigration: false,
      hasSecurityBoundaryChange: false,
      hasDesignAmbiguity: false,
    });

    expect(result.classification).toBe("direct");
    expect(result.reason).toContain("localized");
    expect(result.signals).toEqual(expect.arrayContaining([
      { name: "affected_file_count", value: 1, severity: "low" },
      { name: "affected_capability_count", value: 1, severity: "low" },
    ]));
  });

  test("classifies cross-cutting ambiguous work as architectural", () => {
    const result = classifyChange({
      affectedFiles: Array.from({ length: 5 }, (_, index) => `src/module-${index}.ts`),
      affectedCapabilities: ["runtime", "policy", "review"],
      hasPublicContractChange: true,
      hasDataMigration: false,
      hasSecurityBoundaryChange: true,
      hasDesignAmbiguity: true,
    });

    expect(result.classification).toBe("architectural");
    expect(result.signals.filter((signal) => signal.severity === "high").map((signal) => signal.name)).toEqual(
      expect.arrayContaining(["cross_capability", "security_boundary", "design_ambiguity"]),
    );
  });

  test("records explicit justified overrides and rejects empty reasons", () => {
    const input = {
      affectedFiles: ["src/review/parser.ts"],
      affectedCapabilities: ["review"],
      hasPublicContractChange: false,
      hasDataMigration: false,
      hasSecurityBoundaryChange: false,
      hasDesignAmbiguity: false,
    };

    const overridden = classifyChange(input, {
      classification: "bounded",
      reason: "The parser format is consumed by external plugins.",
      actor: "user",
    });
    expect(overridden).toMatchObject({
      classification: "bounded",
      computedClassification: "direct",
      override: { actor: "user" },
    });
    expect(() => classifyChange(input, {
      classification: "bounded",
      reason: " ",
      actor: "user",
    })).toThrow(expect.objectContaining({ code: "COMPLEXITY_OVERRIDE_INVALID" }) as HarnessError);
  });
});
