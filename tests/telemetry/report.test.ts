import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildTelemetryReport,
  telemetryReportInputSchema,
  type TelemetryReportInput,
} from "../../src/telemetry/report.ts";
import type { UsageRecord } from "../../src/telemetry/usage.ts";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: 1,
    invocationId: "invocation-builder",
    runId: "run-12.5",
    phase: "implementation",
    role: "builder",
    taskId: "12.5",
    provider: "openai",
    model: "test-model",
    inputTokens: 80,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 10,
    totalTokens: 100,
    durationMs: 200,
    costUsd: 0.1,
    source: "provider",
    ...overrides,
  };
}

function baseInput(): TelemetryReportInput {
  return {
    runId: "run-12.5",
    status: "completed" as const,
    invocations: [
      { usage: usage(), activity: "implementation" as const },
      {
        usage: usage({
          invocationId: "invocation-validator",
          phase: "validation",
          role: "validator",
          taskId: undefined,
          inputTokens: 690,
          cacheReadTokens: 100,
          outputTokens: 210,
          totalTokens: 1_000,
          durationMs: 1_500,
          costUsd: 1,
        }),
        activity: "final_validation" as const,
      },
    ],
    context: [
      {
        phase: "implementation" as const,
        category: "openspec" as const,
        inputTokens: 50,
        measurement: "estimated" as const,
      },
      {
        phase: "validation" as const,
        category: "repository" as const,
        inputTokens: 690,
        measurement: "exact" as const,
      },
    ],
    budgetDecisions: [
      {
        phase: "planning" as const,
        activity: "specialist_opinion" as const,
        status: "allowed" as const,
        estimatedSaving: null,
        reason: "Specialist opinion fits the optional planning budget",
      },
      {
        phase: "planning" as const,
        activity: "debate" as const,
        status: "skipped_optional" as const,
        estimatedSaving: { totalTokens: 200, costUsd: 0.2 },
        reason: "Debate exceeded the optional planning budget",
      },
    ],
    outcomes: [
      { phase: "implementation" as const, failures: 1, retries: 1 },
    ],
    diagnostics: [],
    comparisons: {
      minimumRepresentativeRuns: 3,
      runs: [],
    },
  };
}

describe("telemetry report", () => {
  test("emits compact phase summaries and labels context measurements", () => {
    const report = buildTelemetryReport(baseInput());

    expect(report.phases.map(({ phase }) => phase)).toEqual([
      "planning",
      "implementation",
      "validation",
    ]);
    expect(report.phases[1]?.context).toEqual([
      { category: "openspec", inputTokens: 50, measurement: "estimated" },
    ]);
    expect(report.phases[2]?.routing).toEqual([
      {
        role: "validator",
        provider: "openai",
        model: "test-model",
        invocations: 1,
        totalTokens: 1_000,
      },
    ]);
    expect(report.skippedOptional).toEqual([
      {
        phase: "planning",
        activity: "debate",
        estimatedSaving: { totalTokens: 200, costUsd: 0.2 },
        measurement: "estimated",
        reason: "Debate exceeded the optional planning budget",
      },
    ]);
    expect(report.optionalDecisions).toEqual([
      {
        phase: "planning",
        activity: "specialist_opinion",
        status: "included",
        reason: "Specialist opinion fits the optional planning budget",
      },
      {
        phase: "planning",
        activity: "debate",
        status: "skipped",
        reason: "Debate exceeded the optional planning budget",
      },
    ]);
  });

  test("accepts judgment usage and reports its skipped optional activity", () => {
    const input = baseInput();
    input.invocations.push({
      usage: usage({
        invocationId: "invocation-judgment",
        phase: "planning",
        role: "judgment",
        taskId: undefined,
        model: "jev-test",
        inputTokens: 1_000,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: 0,
        totalTokens: 1_000,
        costUsd: 0.000042,
      }),
      activity: "judgment" as const,
    });
    input.budgetDecisions.push({
      phase: "planning" as const,
      activity: "judgment" as const,
      status: "skipped_optional" as const,
      estimatedSaving: { totalTokens: 500, costUsd: 0.00002 },
      reason: "Judgment exceeded the optional planning budget",
    });

    const parsed = telemetryReportInputSchema.parse(input);
    const report = buildTelemetryReport(parsed);

    expect(report.phases[0]?.routing).toEqual([
      expect.objectContaining({ role: "judgment", model: "jev-test", invocations: 1 }),
    ]);
    expect(report.activityUsage).toContainEqual(
      expect.objectContaining({ activity: "judgment", mandatory: false, totalTokens: 1_000 }),
    );
    expect(report.skippedOptional).toContainEqual(
      expect.objectContaining({ phase: "planning", activity: "judgment" }),
    );
  });

  test("sanitizes authentication and manual fixture details", async () => {
    const fixture = JSON.parse(await readFile(
      resolve(import.meta.dir, "../fixtures/manual/actions.json"),
      "utf8",
    )) as {
      secret: string;
      planned: { reason: string; instructions: string[] };
    };
    const input = baseInput();
    input.diagnostics.push({
      phase: "implementation",
      category: "authentication",
      detail: `${fixture.planned.reason}; ${fixture.planned.instructions.join("; ")}; Authorization: Bearer bearer-secret; --password hunter2`,
      secretValues: [fixture.secret],
    });

    const serialized = JSON.stringify(buildTelemetryReport(input));

    expect(serialized).not.toContain(fixture.secret);
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("[REDACTED]");
  });

  test("does not support savings claims with insufficient or worse-quality comparisons", () => {
    const insufficient = buildTelemetryReport(baseInput());
    expect(insufficient.optimization).toMatchObject({
      status: "insufficient_data",
      representativeRuns: 0,
      minimumRepresentativeRuns: 3,
      observedReductionPercent: null,
      measurement: null,
      qualityPreserved: null,
      savingsClaim: null,
    });

    const regressedInput = baseInput();
    regressedInput.comparisons.runs = [
      {
        id: "comparison-1",
        representative: true,
        measurement: "exact",
        baseline: { totalTokens: 1_000, escapedDefects: 0, finalReviewFindings: 0 },
        candidate: { totalTokens: 600, escapedDefects: 1, finalReviewFindings: 0 },
      },
      {
        id: "comparison-2",
        representative: true,
        measurement: "exact",
        baseline: { totalTokens: 1_000, escapedDefects: 0, finalReviewFindings: 0 },
        candidate: { totalTokens: 600, escapedDefects: 0, finalReviewFindings: 0 },
      },
      {
        id: "comparison-3",
        representative: true,
        measurement: "exact",
        baseline: { totalTokens: 1_000, escapedDefects: 0, finalReviewFindings: 0 },
        candidate: { totalTokens: 600, escapedDefects: 0, finalReviewFindings: 0 },
      },
    ];
    const regressed = buildTelemetryReport(regressedInput);

    expect(regressed.optimization.status).toBe("quality_regression");
    expect(regressed.optimization.observedReductionPercent).toBe(40);
    expect(regressed.optimization.savingsClaim).toBeNull();
  });

  test("reports expensive final validation without treating it as removable", () => {
    const report = buildTelemetryReport(baseInput());
    const validation = report.activityUsage.find(
      ({ activity }) => activity === "final_validation",
    );

    expect(validation).toMatchObject({
      activity: "final_validation",
      mandatory: true,
      totalTokens: 1_000,
    });
    expect(report.recommendations).toContainEqual({
      activity: "final_validation",
      mandatory: true,
      removable: false,
      actions: ["optimize_context", "optimize_model_routing"],
    });
    expect(report.correctness).toEqual({
      mandatoryGatesPreserved: true,
      acceptanceCriteriaUnchanged: true,
    });
  });

  test("rejects unstructured prompt and tool-output fields", () => {
    expect(() => telemetryReportInputSchema.parse({
      ...baseInput(),
      rawPrompt: "token=must-not-enter-telemetry",
    })).toThrow();
  });
});