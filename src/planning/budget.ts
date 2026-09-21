import { HarnessError } from "../shared/errors.ts";
import { readCliFlag } from "../shared/cli-flags.ts";
import { BudgetLedger, type BudgetAmount, type BudgetLimit } from "../telemetry/budget.ts";

/**
 * The planning phase's token and cost limits. They are forecasts: a stage whose estimate would
 * exceed a limit is skipped when optional and refused when mandatory. Override them with
 * `--planning-max-tokens` / `--planning-max-cost` or `MUSTER_PLANNING_MAX_TOKENS` /
 * `MUSTER_PLANNING_MAX_COST_USD`; a value of `unlimited`, `none` or `off` removes that cap.
 */
export const DEFAULT_PLANNING_MAX_TOKENS = 1_000_000;
export const DEFAULT_PLANNING_MAX_COST_USD = 1.5;

/** What each stage is expected to cost, before it runs. */
export const DEFAULT_BUDGET_ESTIMATES = {
  specialist_opinion: { totalTokens: 20_000, costUsd: 0.12 },
  debate: { totalTokens: 25_000, costUsd: 0.15 },
  synthesis: { totalTokens: 50_000, costUsd: 0.3 },
} as const satisfies Record<"specialist_opinion" | "debate" | "synthesis", BudgetAmount>;

const UNLIMITED_BUDGET_VALUES = new Set(["unlimited", "none", "off"]);

/** Returns `undefined` for "unlimited"/"none"/"off", meaning that dimension is not capped. */
export function parseBudgetLimit(value: string, fallback: number, label: string): number | undefined {
  if (!value) return fallback;
  if (UNLIMITED_BUDGET_VALUES.has(value.trim().toLowerCase())) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HarnessError(
      "BUDGET_CONFIG_INVALID",
      `${label} must be a positive number, or "unlimited"/"none"/"off" to disable the cap`,
      { label, value },
    );
  }
  return parsed;
}

export function planningBudget(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): BudgetLedger {
  const totalTokens = parseBudgetLimit(
    readCliFlag("planning-max-tokens", argv) || env.MUSTER_PLANNING_MAX_TOKENS?.trim() || "",
    DEFAULT_PLANNING_MAX_TOKENS,
    "planning max tokens",
  );
  const costUsd = parseBudgetLimit(
    readCliFlag("planning-max-cost", argv) || env.MUSTER_PLANNING_MAX_COST_USD?.trim() || "",
    DEFAULT_PLANNING_MAX_COST_USD,
    "planning max cost",
  );
  const limit: BudgetLimit = {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return new BudgetLedger({ phases: Object.keys(limit).length > 0 ? { planning: limit } : {} });
}
