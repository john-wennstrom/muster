import { z } from "zod";
import type { BudgetActivity } from "./budget.ts";
import {
  aggregateUsage,
  type UsagePhase,
  type UsageRecord,
} from "./usage.ts";
import {
  sanitizeTelemetryDiagnostic,
  sanitizeTelemetryText,
  telemetryDiagnosticInputSchema,
} from "./redaction.ts";

const phases = ["planning", "implementation", "validation"] as const;
const contextCategories = [
  "policy",
  "openspec",
  "repository",
  "dependency",
  "peer",
  "tools",
  "duplicate",
] as const;
const budgetActivities = [
  "specialist_opinion",
  "debate",
  "exploratory_model",
  "tests",
  "review",
  "final_validation",
  "openspec_integrity",
  "permission_enforcement",
  "manual_checkpoint",
  "implementation",
  "synthesis",
] as const;
const optionalActivities = new Set<BudgetActivity>([
  "specialist_opinion",
  "debate",
  "exploratory_model",
]);

const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();
const nullableCost = nonNegativeNumber.nullable();
const measurementSchema = z.enum(["exact", "estimated"]);
const phaseSchema = z.enum(phases);
const activitySchema = z.enum(budgetActivities);

const usageRecordSchema = z.object({
  schemaVersion: z.literal(1),
  invocationId: z.string().min(1),
  runId: z.string().min(1),
  phase: phaseSchema,
  role: z.enum(["architect", "builder", "reviewer", "validator", "fusion"]),
  taskId: z.string().min(1).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: nonNegativeInteger,
  cacheReadTokens: nonNegativeInteger.nullable(),
  cacheWriteTokens: nonNegativeInteger.nullable(),
  outputTokens: nonNegativeInteger,
  totalTokens: nonNegativeInteger,
  durationMs: nonNegativeNumber,
  costUsd: nullableCost,
  source: z.enum(["provider", "legacy-aggregate"]),
}).strict();

const budgetAmountSchema = z.object({
  totalTokens: nonNegativeNumber,
  costUsd: nullableCost,
}).strict();

const comparisonSideSchema = z.object({
  totalTokens: nonNegativeInteger,
  escapedDefects: nonNegativeInteger,
  finalReviewFindings: nonNegativeInteger,
}).strict();

export const telemetryReportInputSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["completed", "failed", "blocked", "cancelled"]),
  invocations: z.array(z.object({
    usage: usageRecordSchema,
    activity: activitySchema,
  }).strict()),
  context: z.array(z.object({
    phase: phaseSchema,
    category: z.enum(contextCategories),
    inputTokens: nonNegativeInteger,
    measurement: measurementSchema,
  }).strict()),
  budgetDecisions: z.array(z.object({
    phase: phaseSchema,
    activity: activitySchema,
    status: z.enum(["allowed", "skipped_optional", "blocked_mandatory"]),
    estimatedSaving: budgetAmountSchema.nullable(),
    reason: z.string().min(1).max(8_192),
  }).strict()),
  outcomes: z.array(z.object({
    phase: phaseSchema,
    failures: nonNegativeInteger,
    retries: nonNegativeInteger,
  }).strict()),
  diagnostics: z.array(telemetryDiagnosticInputSchema),
  comparisons: z.object({
    minimumRepresentativeRuns: z.number().int().positive(),
    runs: z.array(z.object({
      id: z.string().min(1),
      representative: z.boolean(),
      measurement: measurementSchema,
      baseline: comparisonSideSchema,
      candidate: comparisonSideSchema,
    }).strict()),
  }).strict(),
}).strict().superRefine((input, context) => {
  const invocationIds = new Set<string>();
  for (const [index, invocation] of input.invocations.entries()) {
    if (invocation.usage.runId !== input.runId) {
      context.addIssue({
        code: "custom",
        path: ["invocations", index, "usage", "runId"],
        message: "Usage record belongs to a different run",
      });
    }
    if (invocationIds.has(invocation.usage.invocationId)) {
      context.addIssue({
        code: "custom",
        path: ["invocations", index, "usage", "invocationId"],
        message: "Invocation identifiers must be unique",
      });
    }
    invocationIds.add(invocation.usage.invocationId);
  }

  const comparisonIds = new Set<string>();
  for (const [index, comparison] of input.comparisons.runs.entries()) {
    if (comparisonIds.has(comparison.id)) {
      context.addIssue({
        code: "custom",
        path: ["comparisons", "runs", index, "id"],
        message: "Comparison identifiers must be unique",
      });
    }
    comparisonIds.add(comparison.id);
  }

  for (const [index, decision] of input.budgetDecisions.entries()) {
    const shouldHaveSaving = decision.status === "skipped_optional";
    if (shouldHaveSaving !== (decision.estimatedSaving !== null)) {
      context.addIssue({
        code: "custom",
        path: ["budgetDecisions", index, "estimatedSaving"],
        message: "Only skipped optional work may report an estimated saving",
      });
    }
    if (shouldHaveSaving && !optionalActivities.has(decision.activity)) {
      context.addIssue({
        code: "custom",
        path: ["budgetDecisions", index, "activity"],
        message: "Mandatory work cannot be reported as skipped optimization",
      });
    }
  }
});

export type TelemetryReportInput = z.input<typeof telemetryReportInputSchema>;
type ParsedTelemetryReportInput = z.output<typeof telemetryReportInputSchema>;

function isMandatory(activity: BudgetActivity): boolean {
  return !optionalActivities.has(activity);
}

function recordsFor(
  input: ParsedTelemetryReportInput,
  phase?: UsagePhase,
): UsageRecord[] {
  return input.invocations
    .filter((invocation) => phase === undefined || invocation.usage.phase === phase)
    .map((invocation) => invocation.usage);
}

function routingSummary(records: readonly UsageRecord[]) {
  const grouped = new Map<string, {
    role: UsageRecord["role"];
    provider: string;
    model: string;
    invocations: number;
    totalTokens: number;
  }>();
  for (const record of records) {
    const key = `${record.role}\0${record.provider}\0${record.model}`;
    const current = grouped.get(key) ?? {
      role: record.role,
      provider: record.provider,
      model: record.model,
      invocations: 0,
      totalTokens: 0,
    };
    current.invocations++;
    current.totalTokens += record.totalTokens;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    left.role.localeCompare(right.role) ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model)
  );
}

function contextSummary(
  input: ParsedTelemetryReportInput,
  phase: UsagePhase,
) {
  const grouped = new Map<string, {
    category: (typeof contextCategories)[number];
    inputTokens: number;
    measurement: "exact" | "estimated";
  }>();
  for (const item of input.context.filter((candidate) => candidate.phase === phase)) {
    const key = `${item.category}\0${item.measurement}`;
    const current = grouped.get(key) ?? {
      category: item.category,
      inputTokens: 0,
      measurement: item.measurement,
    };
    current.inputTokens += item.inputTokens;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    contextCategories.indexOf(left.category) - contextCategories.indexOf(right.category) ||
    left.measurement.localeCompare(right.measurement)
  );
}

function activityUsage(input: ParsedTelemetryReportInput) {
  const grouped = new Map<BudgetActivity, {
    activity: BudgetActivity;
    mandatory: boolean;
    invocations: number;
    totalTokens: number;
    cost: { knownUsd: number; completeness: "complete" | "partial" | "unavailable" };
    records: UsageRecord[];
  }>();
  for (const invocation of input.invocations) {
    const current = grouped.get(invocation.activity) ?? {
      activity: invocation.activity,
      mandatory: isMandatory(invocation.activity),
      invocations: 0,
      totalTokens: 0,
      cost: { knownUsd: 0, completeness: "unavailable" },
      records: [],
    };
    current.records.push(invocation.usage);
    current.invocations++;
    current.totalTokens += invocation.usage.totalTokens;
    grouped.set(invocation.activity, current);
  }
  return [...grouped.values()]
    .map(({ records, ...summary }) => ({
      ...summary,
      cost: aggregateUsage(records).cost,
    }))
    .sort((left, right) =>
      Number(right.mandatory) - Number(left.mandatory) ||
      right.totalTokens - left.totalTokens ||
      left.activity.localeCompare(right.activity)
    );
}

function optimizationSummary(input: ParsedTelemetryReportInput) {
  const representative = input.comparisons.runs.filter((run) => run.representative);
  const baselineTokens = representative.reduce(
    (total, run) => total + run.baseline.totalTokens,
    0,
  );
  const candidateTokens = representative.reduce(
    (total, run) => total + run.candidate.totalTokens,
    0,
  );
  const observedReductionPercent = baselineTokens === 0
    ? null
    : Math.round(((baselineTokens - candidateTokens) / baselineTokens) * 10_000) / 100;
  const measurement = representative.length === 0
    ? null
    : representative.some((run) => run.measurement === "estimated")
      ? "estimated" as const
      : "exact" as const;
  const enoughData = representative.length >= input.comparisons.minimumRepresentativeRuns;
  const qualityPreserved = representative.length === 0
    ? null
    : representative.every((run) =>
        run.candidate.escapedDefects <= run.baseline.escapedDefects &&
        run.candidate.finalReviewFindings <= run.baseline.finalReviewFindings
      );
  const targetObserved = observedReductionPercent !== null && observedReductionPercent >= 25;
  const status = !enoughData
    ? "insufficient_data" as const
    : qualityPreserved === false
      ? "quality_regression" as const
      : !targetObserved
        ? "target_not_observed" as const
        : "target_supported" as const;

  return {
    status,
    representativeRuns: representative.length,
    minimumRepresentativeRuns: input.comparisons.minimumRepresentativeRuns,
    observedReductionPercent,
    measurement,
    qualityPreserved,
    savingsClaim: status === "target_supported"
      ? {
          reductionPercent: observedReductionPercent!,
          measurement: measurement!,
          basis: "representative_comparisons" as const,
        }
      : null,
  };
}

export function buildTelemetryReport(input: unknown) {
  const parsed = telemetryReportInputSchema.parse(input);
  const allRecords = recordsFor(parsed);
  const activities = activityUsage(parsed);
  const outcomeByPhase = new Map(parsed.outcomes.map((outcome) => [outcome.phase, outcome]));
  const diagnostics = parsed.diagnostics.map(sanitizeTelemetryDiagnostic);
  const phaseSummaries = phases.map((phase) => {
    const records = recordsFor(parsed, phase);
    const outcome = outcomeByPhase.get(phase);
    return {
      phase,
      usage: aggregateUsage(records),
      routing: routingSummary(records),
      context: contextSummary(parsed, phase),
      failures: outcome?.failures ?? 0,
      retries: outcome?.retries ?? 0,
      diagnostics: diagnostics.filter((diagnostic) => diagnostic.phase === phase),
    };
  });
  const largestActivityTokens = activities.reduce(
    (largest, activity) => Math.max(largest, activity.totalTokens),
    0,
  );
  const recommendations = activities
    .filter((activity) =>
      activity.activity === "final_validation" &&
      activity.totalTokens > 0 &&
      activity.totalTokens === largestActivityTokens
    )
    .map(() => ({
      activity: "final_validation" as const,
      mandatory: true as const,
      removable: false as const,
      actions: ["optimize_context", "optimize_model_routing"] as const,
    }));

  return Object.freeze({
    schemaVersion: 1 as const,
    runId: parsed.runId,
    status: parsed.status,
    usage: aggregateUsage(allRecords),
    phases: Object.freeze(phaseSummaries),
    activityUsage: Object.freeze(activities),
    optionalDecisions: Object.freeze(parsed.budgetDecisions
      .filter((decision) => optionalActivities.has(decision.activity))
      .filter((decision) => decision.status !== "blocked_mandatory")
      .map((decision) => ({
        phase: decision.phase,
        activity: decision.activity,
        status: decision.status === "allowed" ? "included" as const : "skipped" as const,
        reason: sanitizeTelemetryText(decision.reason),
      }))),
    skippedOptional: Object.freeze(parsed.budgetDecisions
      .filter((decision) => decision.status === "skipped_optional")
      .map((decision) => ({
        phase: decision.phase,
        activity: decision.activity,
        estimatedSaving: decision.estimatedSaving!,
        measurement: "estimated" as const,
        reason: sanitizeTelemetryText(decision.reason),
      }))),
    blockedMandatory: Object.freeze(parsed.budgetDecisions
      .filter((decision) => decision.status === "blocked_mandatory")
      .map((decision) => ({
        phase: decision.phase,
        activity: decision.activity,
        reason: sanitizeTelemetryText(decision.reason),
      }))),
    optimization: Object.freeze(optimizationSummary(parsed)),
    recommendations: Object.freeze(recommendations),
    correctness: Object.freeze({
      mandatoryGatesPreserved: true as const,
      acceptanceCriteriaUnchanged: true as const,
    }),
  });
}