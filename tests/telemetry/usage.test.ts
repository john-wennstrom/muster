import { describe, expect, test } from "bun:test";
import {
  aggregateUsage,
  createUsageRecord,
  usageFromLegacyRun,
} from "../../src/telemetry/usage.ts";

describe("usage telemetry", () => {
  test("preserves provider token categories, duration, and model assignment", () => {
    const record = createUsageRecord({
      runId: "run-1",
      phase: "implementation",
      role: "builder",
      taskId: "1.1",
      model: { provider: "openai", id: "gpt-example" },
      usage: {
        input: 10,
        cacheRead: 20,
        cacheWrite: 30,
        output: 40,
        totalTokens: 100,
        cost: { total: 0.25 },
      },
      durationMs: 1234,
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      runId: "run-1",
      phase: "implementation",
      role: "builder",
      taskId: "1.1",
      provider: "openai",
      model: "gpt-example",
      inputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
      outputTokens: 40,
      totalTokens: 100,
      durationMs: 1234,
      costUsd: 0.25,
      source: "provider",
    });
  });

  test("represents provider-omitted cost as unavailable rather than zero", () => {
    const record = createUsageRecord({
      runId: "run-1",
      phase: "planning",
      role: "architect",
      model: { provider: "anthropic", id: "claude-example" },
      usage: { input: 5, output: 7 },
      durationMs: 100,
    });

    expect(record.costUsd).toBeNull();
    expect(aggregateUsage([record]).cost).toEqual({
      knownUsd: 0,
      completeness: "unavailable",
    });
  });

  test("aggregates cache tokens and labels partial costs", () => {
    const known = createUsageRecord({
      runId: "run-1",
      phase: "planning",
      role: "architect",
      model: { provider: "openai", id: "one" },
      usage: { input: 3, cacheRead: 4, cacheWrite: 5, output: 6, cost: { total: 0.1 } },
      durationMs: 10,
    });
    const unknown = createUsageRecord({
      runId: "run-1",
      phase: "implementation",
      role: "builder",
      model: { provider: "other", id: "two" },
      usage: { input: 7, cacheRead: 8, cacheWrite: 9, output: 10 },
      durationMs: 20,
    });

    expect(aggregateUsage([known, unknown])).toEqual({
      invocations: 2,
      inputTokens: 10,
      cacheReadTokens: 12,
      cacheWriteTokens: 14,
      outputTokens: 16,
      totalTokens: 52,
      durationMs: 30,
      cost: { knownUsd: 0.1, completeness: "partial" },
      assignments: ["openai/one", "other/two"],
    });
  });

  test("adapts imported AgentRun totals without fabricating provider detail", () => {
    const record = usageFromLegacyRun("run-1", "implementation", {
      role: "BUILDER",
      model: "openai/gpt-example",
      tokensIn: 60,
      tokensOut: 40,
      costUsd: 0,
      ms: 500,
    });

    expect(record).toMatchObject({
      inputTokens: 60,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: 40,
      totalTokens: 100,
      costUsd: null,
      source: "legacy-aggregate",
    });
  });
});