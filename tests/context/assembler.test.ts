import { describe, expect, test } from "bun:test";
import { assembleTaskCapsule } from "../../src/context/assembler.ts";
import { createDependencyReport } from "../../src/agents/reports.ts";

const contract = {
  taskId: "8.2",
  definition: "Build prioritized task context.",
  requirements: ["Required context is never truncated"],
  scenarios: ["Capsule exceeds budget"],
  decisions: ["Optional context is removed first"],
  readScopes: ["src/context/**"],
  writeScopes: ["src/context/**", "tests/context/**"],
  acceptance: ["Focused tests pass"],
  tokenBudget: 100,
};

describe("task context assembler", () => {
  test("keeps the complete contract and removes optional context first", () => {
    const capsule = assembleTaskCapsule({
      contract,
      requiredTokenEstimate: 60,
      dependencyReports: [createDependencyReport({
        schemaVersion: 1,
        runId: "run-1",
        taskId: "8.1",
        outcome: "completed",
        summary: "Fresh role runner is available.",
        changedInterfaces: ["runFreshRoleTask"],
        evidence: ["bun test tests/agents/fresh-context.test.ts"],
        createdAt: "2026-09-12T12:00:00.000Z",
      })],
      slices: [
        { id: "required-rule", priority: "required", content: "Project rule", tokenEstimate: 10 },
        { id: "relevant-code", priority: "relevant", content: "Selected code", tokenEstimate: 25 },
        { id: "optional-example", priority: "relevant", content: "Optional example", tokenEstimate: 20 },
        { id: "full-design", priority: "available", content: "Large design", tokenEstimate: 500 },
        { id: "unrelated-transcript", priority: "excluded", content: "Private transcript", tokenEstimate: 10 },
      ],
    });

    expect(capsule.included.map((slice) => slice.id)).toEqual([
      "task-contract",
      "required-rule",
      "relevant-code",
    ]);
    expect(capsule.content).toContain("Fresh role runner is available.");
    expect(capsule.content).toContain("full-design");
    expect(capsule.content).not.toContain("Optional example");
    expect(capsule.content).not.toContain("Private transcript");
    expect(capsule.available).toEqual(["full-design"]);
    expect(capsule.excluded).toEqual(["unrelated-transcript"]);
  });

  test("fails instead of truncating required contracts", () => {
    expect(() => assembleTaskCapsule({
      contract: { ...contract, tokenBudget: 50 },
      requiredTokenEstimate: 60,
    })).toThrow(/Required context.*exceeds/);
  });
});