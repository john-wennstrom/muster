import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { changeRunId } from "../persistence/change-usage-store.ts";

/**
 * Decision audit records: one JSON record per decision under the change's run identifier,
 * beside its usage records. A record holds a digest of the redacted state, never the state,
 * so repository content is not copied to a second place; full states for calibration come
 * from the fixture recorder instead.
 */

export const JUDGMENT_RECORD_DIRECTORY = "judgment";

const unitInterval = z.number().min(0).max(1);
const nonNegative = z.number().finite().nonnegative();

const reasonSchema = z.enum([
  "disabled",
  "not_configured",
  "invalid_configuration",
  "budget",
  "state_denied",
  "state_too_large",
  "timeout",
  "rate_limit",
  "network",
  "server",
  "invalid_response",
  "model_mismatch",
  "aborted",
]);

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: unitInterval }).strict(),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), unitInterval),
    confidence: unitInterval,
  }).strict(),
  z.object({
    type: z.literal("score"),
    score: z.number().finite(),
    probabilities: z.record(z.string(), unitInterval),
    confidence: unitInterval,
  }).strict(),
]);

const avoidedSchema = z.object({
  activity: z.string().min(1),
  totalTokens: nonNegative,
  costUsd: nonNegative.nullable(),
}).strict();

export const decisionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  recordId: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  decision: z.string().min(1),
  decisionVersion: z.number().int().positive(),
  phase: z.enum(["planning", "implementation", "validation"]),
  taskId: z.string().min(1).optional(),
  /** Null when the mode could not be resolved (invalid configuration). */
  mode: z.enum(["shadow", "enforce"]).nullable(),
  status: z.enum(["answered", "unavailable"]),
  unavailableReason: reasonSchema.nullable(),
  requestedModel: z.string().min(1),
  reportedModel: z.string().min(1).nullable(),
  answers: z.record(z.string(), answerSchema).nullable(),
  gate: z.union([
    z.object({ act: z.literal(true), value: z.json() }).strict(),
    z.object({ act: z.literal(false), reason: z.string() }).strict(),
  ]).nullable(),
  /** The gate would have acted, whether or not the mode handed the outcome to the caller. */
  wouldHaveActed: z.boolean(),
  /** The caller was handed an acting outcome (enforce mode only). */
  acted: z.boolean(),
  spend: z.object({
    inputTokens: nonNegative,
    outputTokens: nonNegative,
    costUsd: nonNegative,
  }).strict().nullable(),
  stateDigest: z.string().min(1).nullable(),
  /** What the existing behavior or the expensive stage actually concluded, merged over time. */
  observed: z.record(z.string(), z.json()),
  /** Whether the observation agreed with the judgment; null until reconciled. */
  agreement: z.boolean().nullable(),
  /** The activity acting avoided, from the budget estimate of the skipped stage. */
  avoided: avoidedSchema.nullable(),
}).strict();

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

export function digestState(stateText: string): string {
  return `sha256:${createHash("sha256").update(stateText).digest("hex")}`;
}

export type NewDecisionRecord = Omit<
  DecisionRecord,
  "schemaVersion" | "recordId" | "runId" | "createdAt" | "observed" | "agreement" | "avoided"
> & { avoided?: DecisionRecord["avoided"] };

export function createDecisionRecord(
  changeName: string,
  input: NewDecisionRecord,
  now: () => Date = () => new Date(),
): DecisionRecord {
  return decisionRecordSchema.parse({
    ...input,
    schemaVersion: 1,
    recordId: `decision-${randomUUID()}`,
    runId: changeRunId(changeName),
    createdAt: now().toISOString(),
    observed: {},
    agreement: null,
    avoided: input.avoided ?? null,
  });
}

export async function writeDecisionRecord(
  store: AtomicJsonStore,
  changeName: string,
  record: DecisionRecord,
): Promise<void> {
  const parsed = decisionRecordSchema.parse(record);
  await store.write(changeRunId(changeName), recordPath(parsed.recordId), parsed);
}

export async function listDecisionRecords(
  store: AtomicJsonStore,
  changeName: string,
): Promise<DecisionRecord[]> {
  const runId = changeRunId(changeName);
  const paths = (await store.list(runId, JUDGMENT_RECORD_DIRECTORY))
    .filter((path) => path.endsWith(".json") && !path.split("/").pop()!.startsWith("."));
  return Promise.all(paths.map(async (path) =>
    decisionRecordSchema.parse(await store.read(runId, path))));
}

function recordPath(recordId: string): string {
  return `${JUDGMENT_RECORD_DIRECTORY}/${recordId}.json`;
}

export interface Reconciliation {
  /** Keys merge into what earlier reconciliations recorded; a repeated key takes the newer value. */
  readonly observed?: Readonly<Record<string, z.infer<typeof z.json>>>;
  /** Supplied by the call site, the only place that can compare its decision with the outcome. Latest wins. */
  readonly agreed?: boolean;
  readonly avoided?: NonNullable<DecisionRecord["avoided"]>;
}

export type ReconcileResult =
  | { readonly found: true; readonly record: DecisionRecord }
  | { readonly found: false };

/** Merges observations into a record; a record that does not exist is reported, never raised. */
export async function reconcileDecisionRecord(
  store: AtomicJsonStore,
  changeName: string,
  recordId: string,
  reconciliation: Reconciliation,
): Promise<ReconcileResult> {
  const runId = changeRunId(changeName);
  let existing: DecisionRecord;
  try {
    existing = decisionRecordSchema.parse(await store.read(runId, recordPath(recordId)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { found: false };
    throw error;
  }
  const merged = decisionRecordSchema.parse({
    ...existing,
    observed: { ...existing.observed, ...reconciliation.observed },
    agreement: reconciliation.agreed ?? existing.agreement,
    avoided: reconciliation.avoided ?? existing.avoided,
  });
  await store.write(runId, recordPath(recordId), merged);
  return { found: true, record: merged };
}

export interface DecisionSummary {
  readonly decision: string;
  readonly decisionVersion: number;
  readonly calls: number;
  readonly unavailable: Readonly<Record<string, number>>;
  readonly shadow: number;
  readonly enforced: number;
  readonly wouldHaveActed: number;
  readonly acted: number;
  readonly reconciled: number;
  readonly agreed: number;
  /** Agreed over reconciled records only; null when nothing has been reconciled. */
  readonly agreementRate: number | null;
  readonly spend: { readonly inputTokens: number; readonly costUsd: number };
  /** Estimated cost of the activity avoided, counted only where the decision acted. */
  readonly avoided: { readonly totalTokens: number; readonly costUsd: number };
}

/** Pure per-decision summary; the calibration script and any report consume this same code. */
export function summarizeDecisions(records: readonly DecisionRecord[]): readonly DecisionSummary[] {
  const groups = new Map<string, DecisionRecord[]>();
  for (const record of records) {
    const key = `${record.decision}\0${record.decisionVersion}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()]
    .map((group): DecisionSummary => {
      const unavailable: Record<string, number> = {};
      for (const record of group) {
        if (record.status === "unavailable" && record.unavailableReason) {
          unavailable[record.unavailableReason] = (unavailable[record.unavailableReason] ?? 0) + 1;
        }
      }
      const reconciled = group.filter((record) => record.agreement !== null);
      const agreed = reconciled.filter((record) => record.agreement === true).length;
      const actedRecords = group.filter((record) => record.acted);
      return {
        decision: group[0]!.decision,
        decisionVersion: group[0]!.decisionVersion,
        calls: group.length,
        unavailable,
        shadow: group.filter((record) => record.status === "answered" && record.mode === "shadow").length,
        enforced: group.filter((record) => record.status === "answered" && record.mode === "enforce").length,
        wouldHaveActed: group.filter((record) => record.wouldHaveActed).length,
        acted: actedRecords.length,
        reconciled: reconciled.length,
        agreed,
        agreementRate: reconciled.length === 0 ? null : agreed / reconciled.length,
        spend: {
          inputTokens: group.reduce((sum, record) => sum + (record.spend?.inputTokens ?? 0), 0),
          costUsd: group.reduce((sum, record) => sum + (record.spend?.costUsd ?? 0), 0),
        },
        avoided: {
          totalTokens: actedRecords.reduce((sum, record) => sum + (record.avoided?.totalTokens ?? 0), 0),
          costUsd: actedRecords.reduce((sum, record) => sum + (record.avoided?.costUsd ?? 0), 0),
        },
      };
    })
    .sort((left, right) =>
      left.decision.localeCompare(right.decision) || left.decisionVersion - right.decisionVersion);
}
