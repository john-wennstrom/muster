import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PLANNING_MAX_COST_USD,
  DEFAULT_PLANNING_MAX_TOKENS,
  parseBudgetLimit,
  planningBudget,
} from "../../src/planning/budget.ts";

const forecastOf = (ledger: ReturnType<typeof planningBudget>, totalTokens: number, costUsd: number | null = 0) =>
  ledger.forecast({ phase: "planning", role: "architect", activity: "synthesis", estimate: { totalTokens, costUsd } });

describe("planning budget", () => {
  test("the defaults are stated once and are what the README says", () => {
    expect(DEFAULT_PLANNING_MAX_TOKENS).toBe(1_000_000);
    expect(DEFAULT_PLANNING_MAX_COST_USD).toBe(1.5);
  });

  test("with no override the default limits apply", () => {
    const ledger = planningBudget([], {});
    expect(forecastOf(ledger, DEFAULT_PLANNING_MAX_TOKENS).status).not.toBe("blocked_mandatory");
    expect(forecastOf(ledger, DEFAULT_PLANNING_MAX_TOKENS + 1).status).toBe("blocked_mandatory");
  });

  test("the command line wins over the environment", () => {
    const ledger = planningBudget(["--planning-max-tokens", "1000"], { MUSTER_PLANNING_MAX_TOKENS: "9999999" });
    expect(forecastOf(ledger, 1_001).status).toBe("blocked_mandatory");
    expect(forecastOf(ledger, 1_000).status).not.toBe("blocked_mandatory");
  });

  test("the environment overrides the default, and unlimited removes a cap", () => {
    expect(forecastOf(planningBudget([], { MUSTER_PLANNING_MAX_TOKENS: "500" }), 501).status).toBe("blocked_mandatory");
    expect(forecastOf(planningBudget([], { MUSTER_PLANNING_MAX_TOKENS: "unlimited", MUSTER_PLANNING_MAX_COST_USD: "off" }), 50_000_000, 999).status)
      .not.toBe("blocked_mandatory");
  });

  test("a cost cap applies on its own", () => {
    const ledger = planningBudget([], { MUSTER_PLANNING_MAX_COST_USD: "0.10" });
    expect(forecastOf(ledger, 1, 0.11).status).toBe("blocked_mandatory");
  });

  test("an invalid limit is a configuration error naming what was wrong", () => {
    for (const value of ["abc", "0", "-5"]) {
      expect(() => parseBudgetLimit(value, 1, "planning max tokens")).toThrow(/planning max tokens must be a positive number/);
    }
    expect(() => planningBudget(["--planning-max-cost", "nope"], {})).toThrow(/planning max cost/);
    expect(parseBudgetLimit("", 7, "x")).toBe(7);
    expect(parseBudgetLimit("Unlimited", 7, "x")).toBeUndefined();
  });
});
