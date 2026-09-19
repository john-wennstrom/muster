import { describe, expect, test } from "bun:test";
import { classifyChange } from "../../src/controller/complexity-router.ts";
import { refine } from "../../src/controller/planning.ts";
import { parseTaskDocument } from "../../src/execution/task-parser.ts";
import { runTaskPipeline } from "../../src/execution/task-runner.ts";
import { BudgetLedger, isProtectedMandatoryActivity } from "../../src/telemetry/budget.ts";
import type { UsageRecord } from "../../src/telemetry/usage.ts";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: 1,
    invocationId: "invocation-1",
    runId: "run-1",
    phase: "implementation",
    role: "builder",
    taskId: "12.4",
    provider: "openai",
    model: "test-model",
    inputTokens: 60,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: 20,
    totalTokens: 80,
    durationMs: 100,
    costUsd: 0.08,
    source: "provider",
    ...overrides,
  };
}

describe("hierarchical budgets", () => {
  test("charges usage to matching run, phase, role, and task budgets", () => {
    const ledger = new BudgetLedger({
      run: { totalTokens: 1_000 },
      phases: { implementation: { totalTokens: 500 } },
      roles: { builder: { totalTokens: 100 } },
      tasks: { "12.4": { totalTokens: 90 } },
    });
    ledger.record(usage());

    const decision = ledger.forecast({
      phase: "implementation",
      role: "builder",
      taskId: "12.4",
      activity: "implementation",
      estimate: { totalTokens: 15, costUsd: 0.01 },
    });

    expect(decision.status).toBe("blocked_mandatory");
    expect(decision.scopes.map(({ scope }) => scope.level)).toEqual([
      "run",
      "phase",
      "role",
      "task",
    ]);
    expect(decision.scopes.filter(({ exceeded }) => exceeded.length > 0)
      .map(({ scope }) => scope.level)).toEqual(["task"]);
  });

  test("skips optional work before blocking protected mandatory gates", () => {
    const ledger = new BudgetLedger({ phases: { planning: { totalTokens: 100 } } });
    ledger.record(usage({ phase: "planning", role: "architect", taskId: undefined }));
    const request = {
      phase: "planning" as const,
      role: "architect" as const,
      estimate: { totalTokens: 25, costUsd: 0.02 },
    };

    const debate = ledger.forecast({ ...request, activity: "debate" });
    const review = ledger.forecast({ ...request, activity: "review" });

    expect(debate).toMatchObject({
      status: "skipped_optional",
      mandatory: false,
      estimatedSaving: request.estimate,
    });
    expect(review).toMatchObject({
      status: "blocked_mandatory",
      mandatory: true,
      estimatedSaving: null,
    });
    expect(isProtectedMandatoryActivity("tests")).toBe(true);
    expect(isProtectedMandatoryActivity("manual_checkpoint")).toBe(true);
  });

  test("skips judgment as optional work and never blocks a mandatory activity", () => {
    const ledger = new BudgetLedger({ phases: { planning: { totalTokens: 100 } } });
    ledger.record(usage({
      phase: "planning",
      role: "judgment",
      taskId: undefined,
      totalTokens: 90,
    }));
    const request = {
      phase: "planning" as const,
      role: "judgment" as const,
      estimate: { totalTokens: 20, costUsd: 0.000001 },
    };

    const judgment = ledger.forecast({ ...request, activity: "judgment" });
    const review = ledger.forecast({ ...request, role: "reviewer", activity: "review" });

    expect(judgment).toMatchObject({
      status: "skipped_optional",
      mandatory: false,
      estimatedSaving: request.estimate,
    });
    expect(review.status).toBe("blocked_mandatory");
    expect(isProtectedMandatoryActivity("judgment")).toBe(false);
    expect(ledger.forecast({
      ...request,
      estimate: { totalTokens: 5, costUsd: 0.000001 },
      activity: "judgment",
    }).status).toBe("allowed");
  });

  test("fails closed when a configured cost budget cannot be evaluated", () => {
    const ledger = new BudgetLedger({ run: { costUsd: 1 } });
    ledger.record(usage({ costUsd: null }));

    const decision = ledger.forecast({
      phase: "validation",
      role: "validator",
      activity: "final_validation",
      estimate: { totalTokens: 10, costUsd: 0.01 },
    });

    expect(decision.status).toBe("blocked_mandatory");
    expect(decision.scopes[0]?.exceeded).toEqual(["costUsdUnavailable"]);
  });
});

describe("budget integration", () => {
  test("forecasts optional planning fan-out and skips debate independently", async () => {
    const calls: string[] = [];
    const ledger = new BudgetLedger({ phases: { planning: { totalTokens: 100 } } });
    ledger.record(usage({
      phase: "planning",
      role: "architect",
      taskId: undefined,
      totalTokens: 60,
    }));
    const result = await refine({
      changeName: "budgeted-design",
      prompt: "Refine the design",
      complexity: classifyChange({
        affectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
        affectedCapabilities: ["planning", "execution", "telemetry"],
        hasPublicContractChange: true,
        hasDataMigration: false,
        hasSecurityBoundaryChange: false,
        hasDesignAmbiguity: true,
      }),
      optionalBudgetAvailable: true,
    }, {
      budget: ledger,
      budgetEstimates: {
        specialist_opinion: { totalTokens: 15, costUsd: 0.01 },
        debate: { totalTokens: 45, costUsd: 0.01 },
        synthesis: { totalTokens: 10, costUsd: 0.01 },
      },
      runAgent: async (request) => {
        calls.push(request.stage);
        return { model: "test-model", content: request.stage };
      },
      writeArtifacts: async () => {},
    });

    expect(calls).toEqual(["specialist_opinion", "specialist_opinion", "synthesis"]);
    expect(result.policy.optional).toEqual({ specialistOpinions: true, debate: false });
    expect(result.budgetDecisions.map(({ status }) => status)).toEqual([
      "allowed",
      "skipped_optional",
      "allowed",
    ]);
    expect(result.budgetDecisions[1]?.estimatedSaving?.totalTokens).toBe(45);
  });

  test("blocks exhausted mandatory review without completing the task", async () => {
    const contents = `## 12. Budget reporting

- [ ] 12.4 Add budgets

  \`\`\`yaml harness-task
  id: "12.4"
  dependsOn: []
  role: builder
  reads: ["src/**"]
  writes: ["src/**"]
  requirements: ["telemetry-and-cost: Enforced hierarchical budgets"]
  scenarios: ["Budget is exhausted before review"]
  verify: ["bun test tests/telemetry/budget.test.ts"]
  manual: null
  \`\`\`
`;
    const calls: string[] = [];
    const result = await runTaskPipeline({
      runId: "run-budget",
      sessionsRoot: "/tmp/muster-budget-test",
      contents,
      task: parseTaskDocument(contents, "tasks.md").tasks[0]!,
      behaviorChanging: false,
      requirements: ["telemetry-and-cost: Enforced hierarchical budgets"],
      scenarios: ["Budget is exhausted before review"],
      reviewBudgetAvailable: true,
      budget: new BudgetLedger({ roles: { reviewer: { totalTokens: 0 } } }),
      reviewBudgetEstimate: { totalTokens: 1, costUsd: 0 },
      runBuilder: async () => {
        calls.push("builder");
        return { claim: "completed", implementationPersisted: true };
      },
      runVerification: async () => {
        calls.push("verification");
        return { passed: true, evidence: ["focused tests passed"] };
      },
      runReview: async () => {
        calls.push("review");
        return { approved: true, findings: [] };
      },
      persistEvidence: async () => { calls.push("persist"); },
    });

    expect(calls).toEqual(["builder", "verification"]);
    expect(result.outcome).toMatchObject({
      status: "blocked",
      synchronizeCheckbox: false,
      blockAffectedBranch: true,
    });
    expect(result.outcome.reason).toContain("mandatory task review budget is unavailable");
    expect(result.contents).toBe(contents);
  });
});