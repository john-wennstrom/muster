import { describe, expect, test } from "bun:test";
import {
  explore,
  promoteExploration,
} from "../../src/controller/explore.ts";
import {
  propose,
  refine,
  type PlanningAgentRequest,
  type PlanningArtifactWriteRequest,
  type PlanningDependencies,
} from "../../src/controller/planning.ts";
import { classifyChange } from "../../src/controller/complexity-router.ts";

const direct = classifyChange({
  affectedFiles: ["src/feature.ts"],
  affectedCapabilities: ["feature"],
  hasPublicContractChange: false,
  hasDataMigration: false,
  hasSecurityBoundaryChange: false,
  hasDesignAmbiguity: false,
});

const architectural = classifyChange({
  affectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
  affectedCapabilities: ["workflow", "agents", "openspec"],
  hasPublicContractChange: true,
  hasDataMigration: false,
  hasSecurityBoundaryChange: false,
  hasDesignAmbiguity: true,
});

function planningHarness(): {
  dependencies: PlanningDependencies;
  calls: PlanningAgentRequest[];
  writes: PlanningArtifactWriteRequest[];
} {
  const calls: PlanningAgentRequest[] = [];
  const writes: PlanningArtifactWriteRequest[] = [];
  return {
    calls,
    writes,
    dependencies: {
      runAgent: async (request) => {
        calls.push(request);
        return { model: `model-${calls.length}`, content: `${request.stage} result` };
      },
      writeArtifacts: async (request) => { writes.push(request); },
    },
  };
}

describe("change planning", () => {
  test("exploration remains read-only and non-durable until explicitly promoted", async () => {
    const exploreCalls: string[] = [];
    const exploration = await explore(
      { prompt: "Consider adding search" },
      {
        runAgent: async (request) => {
          exploreCalls.push(`${request.phase}:${request.access}`);
          return { model: "model-explore", content: "A bounded search design" };
        },
      },
    );
    expect(exploration.artifactsWritten).toBe(false);
    expect(exploreCalls).toEqual(["explore:read"]);

    const subject = planningHarness();
    const promoted = await promoteExploration(exploration, {
      changeName: "add-search",
      complexity: direct,
      optionalBudgetAvailable: true,
    }, subject.dependencies);
    expect(promoted.phase).toBe("propose");
    expect(subject.writes).toHaveLength(1);
    expect(subject.writes[0]?.synthesis.content).toBe("synthesis result");
  });

  test("direct proposals use minimal fan-out and progress without confirmation", async () => {
    const subject = planningHarness();
    const result = await propose({
      changeName: "local-fix",
      prompt: "Fix one local parser",
      complexity: direct,
      optionalBudgetAvailable: true,
    }, subject.dependencies);

    expect(subject.calls.map((call) => call.stage)).toEqual(["synthesis"]);
    expect(subject.writes).toHaveLength(1);
    expect(result.policy.budgetDecision).toBe("minimal_route");
    expect(result.artifactsWritten).toBe(true);
  });

  test("architectural refinement runs opinions and debate when policy permits", async () => {
    const subject = planningHarness();
    const result = await refine({
      changeName: "cross-cutting-change",
      prompt: "Refine an ambiguous cross-cutting design",
      complexity: architectural,
      optionalBudgetAvailable: true,
    }, subject.dependencies);

    expect(subject.calls.map((call) => call.stage)).toEqual([
      "specialist_opinion",
      "specialist_opinion",
      "debate",
      "synthesis",
    ]);
    expect(result.policy.optional).toEqual({ specialistOpinions: true, debate: true });
    expect(result.complexity.reason).toContain("cross-cutting");
    expect(subject.writes).toHaveLength(1);
  });

  test("architectural planning skips optional reasoning when budget disallows it", async () => {
    const subject = planningHarness();
    const result = await propose({
      changeName: "budgeted-change",
      prompt: "Plan within the available budget",
      complexity: architectural,
      optionalBudgetAvailable: false,
    }, subject.dependencies);

    expect(subject.calls.map((call) => call.stage)).toEqual(["synthesis"]);
    expect(result.policy.budgetDecision).toBe("optional_skipped_budget");
    expect(subject.writes).toHaveLength(1);
  });
});