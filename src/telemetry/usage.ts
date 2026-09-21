import { randomUUID } from "node:crypto";
import type { AgentRun } from "../agents/run-record.ts";

export type UsagePhase = "planning" | "implementation" | "validation";
export type UsageRole =
  | "architect"
  | "builder"
  | "reviewer"
  | "validator"
  | "fusion"
  | "judgment";

export interface ProviderUsage {
  input?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  output?: number | null;
  totalTokens?: number | null;
  cost?: { total?: number | null } | null;
}

export interface UsageRecord {
  schemaVersion: 1;
  invocationId: string;
  runId: string;
  phase: UsagePhase;
  role: UsageRole;
  taskId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  costUsd: number | null;
  source: "provider" | "legacy-aggregate";
}

function count(value: number | null | undefined): number {
  return Number.isFinite(value) && value! >= 0 ? value! : 0;
}

function optionalCount(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : count(value);
}

export function createUsageRecord(input: {
  runId: string;
  phase: UsagePhase;
  role: UsageRole;
  taskId?: string;
  model: { provider: string; id: string };
  usage: ProviderUsage;
  durationMs: number;
}): UsageRecord {
  const inputTokens = count(input.usage.input);
  const cacheReadTokens = optionalCount(input.usage.cacheRead);
  const cacheWriteTokens = optionalCount(input.usage.cacheWrite);
  const outputTokens = count(input.usage.output);
  const calculatedTotal =
    inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + outputTokens;

  return {
    schemaVersion: 1,
    invocationId: randomUUID(),
    runId: input.runId,
    phase: input.phase,
    role: input.role,
    taskId: input.taskId,
    provider: input.model.provider,
    model: input.model.id,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: count(input.usage.totalTokens) || calculatedTotal,
    durationMs: count(input.durationMs),
    costUsd: optionalCount(input.usage.cost?.total),
    source: "provider",
  };
}

export function usageFromLegacyRun(
  runId: string,
  phase: UsagePhase,
  run: Pick<AgentRun, "role" | "model" | "tokensIn" | "tokensOut" | "costUsd" | "ms">,
  taskId?: string,
): UsageRecord {
  const separator = run.model.indexOf("/");
  const provider = separator > 0 ? run.model.slice(0, separator) : "unknown";
  const model = separator > 0 ? run.model.slice(separator + 1) : run.model;
  const inputTokens = count(run.tokensIn);
  const outputTokens = count(run.tokensOut);

  return {
    schemaVersion: 1,
    invocationId: randomUUID(),
    runId,
    phase,
    role: run.role.toLowerCase() as UsageRole,
    taskId,
    provider,
    model,
    inputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs: count(run.ms),
    costUsd: run.costUsd > 0 ? run.costUsd : null,
    source: "legacy-aggregate",
  };
}

export function aggregateUsage(records: readonly UsageRecord[]) {
  const knownCosts = records.filter((record) => record.costUsd !== null);
  const assignments = [
    ...new Set(records.map((record) => `${record.provider}/${record.model}`)),
  ];

  return {
    invocations: records.length,
    inputTokens: records.reduce((total, record) => total + record.inputTokens, 0),
    cacheReadTokens: records.reduce(
      (total, record) => total + (record.cacheReadTokens ?? 0),
      0,
    ),
    cacheWriteTokens: records.reduce(
      (total, record) => total + (record.cacheWriteTokens ?? 0),
      0,
    ),
    outputTokens: records.reduce((total, record) => total + record.outputTokens, 0),
    totalTokens: records.reduce((total, record) => total + record.totalTokens, 0),
    durationMs: records.reduce((total, record) => total + record.durationMs, 0),
    cost: {
      knownUsd: knownCosts.reduce((total, record) => total + record.costUsd!, 0),
      completeness:
        knownCosts.length === 0
          ? ("unavailable" as const)
          : knownCosts.length === records.length
            ? ("complete" as const)
            : ("partial" as const),
    },
    assignments,
  };
}