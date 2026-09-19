import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { changeRunId, recordChangeUsage } from "../persistence/change-usage-store.ts";
import type {
  BudgetAmount,
  BudgetDecision,
  BudgetEvaluator,
} from "../telemetry/budget.ts";
import {
  createUsageRecord,
  type UsagePhase,
  type UsageRecord,
} from "../telemetry/usage.ts";
import {
  JUDGMENT_COST_PER_INPUT_TOKEN_USD,
  JUDGMENT_MODEL,
  JUDGMENT_PROVIDER,
} from "./client.ts";

/** A budget evaluator that can also be charged, as the ledger can. */
export type JudgmentBudget = BudgetEvaluator & { record?(record: UsageRecord): void };

export function judgmentCostUsd(inputTokens: number): number {
  return inputTokens * JUDGMENT_COST_PER_INPUT_TOKEN_USD;
}

export function judgmentEstimate(estimatedTokens: number): BudgetAmount {
  return { totalTokens: estimatedTokens, costUsd: judgmentCostUsd(estimatedTokens) };
}

/**
 * Judgment is an optional activity: a forecast over budget skips the request instead of
 * blocking anything mandatory. With no budget configured, judgment is allowed.
 */
export function forecastJudgment(
  budget: JudgmentBudget | undefined,
  input: { phase: UsagePhase; taskId?: string; estimatedTokens: number },
): { readonly allowed: boolean; readonly decision: BudgetDecision | null } {
  if (!budget) return { allowed: true, decision: null };
  const decision = budget.forecast({
    phase: input.phase,
    role: "judgment",
    taskId: input.taskId,
    activity: "judgment",
    estimate: judgmentEstimate(input.estimatedTokens),
  });
  return { allowed: decision.status === "allowed", decision };
}

/** Input tokens come from the response; output tokens are recorded as zero, not omitted. */
export function createJudgmentUsage(input: {
  changeName: string;
  phase: UsagePhase;
  taskId?: string;
  inputTokens: number;
  durationMs: number;
}): UsageRecord {
  return createUsageRecord({
    runId: changeRunId(input.changeName),
    phase: input.phase,
    role: "judgment",
    taskId: input.taskId,
    model: { provider: JUDGMENT_PROVIDER, id: JUDGMENT_MODEL },
    usage: {
      input: input.inputTokens,
      output: 0,
      cost: { total: judgmentCostUsd(input.inputTokens) },
    },
    durationMs: input.durationMs,
  });
}

/** Writes the record beside the change's other usage and charges the budget, if any. */
export async function emitJudgmentUsage(
  store: AtomicJsonStore,
  changeName: string,
  budget: JudgmentBudget | undefined,
  record: UsageRecord,
): Promise<void> {
  budget?.record?.(record);
  await recordChangeUsage(store, changeName, [record]);
}
