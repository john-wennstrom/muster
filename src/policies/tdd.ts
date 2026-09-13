import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import {
  tddEvidenceRecordSchema,
  type TddEvidenceRecord,
} from "../persistence/records.ts";

type RequiredTddEvidence = Extract<TddEvidenceRecord, { disposition: "required" }>;
type TddException = Extract<TddEvidenceRecord, { disposition: "not_applicable" }>;

export interface TddPolicyInput {
  taskId: string;
  behaviorChanging: boolean;
  requirements: readonly string[];
  scenarios: readonly string[];
  evidence?: TddEvidenceRecord;
}

export interface TddPolicyDecision {
  accepted: boolean;
  reason?: string;
}

type CreateRequiredTddEvidenceInput = Omit<
  RequiredTddEvidence,
  "schemaVersion" | "disposition"
>;

type CreateTddExceptionInput = Omit<
  TddException,
  "schemaVersion" | "disposition"
>;

function sameLinks(actual: readonly string[], expected: readonly string[]): boolean {
  const normalizedActual = [...new Set(actual)].sort();
  const normalizedExpected = [...new Set(expected)].sort();
  return normalizedActual.length === normalizedExpected.length &&
    normalizedActual.every((value, index) => value === normalizedExpected[index]);
}

export function createTddEvidence(
  input: CreateRequiredTddEvidenceInput,
): RequiredTddEvidence {
  return tddEvidenceRecordSchema.parse({
    schemaVersion: 1,
    disposition: "required",
    ...input,
  }) as RequiredTddEvidence;
}

export function createTddException(input: CreateTddExceptionInput): TddException {
  return tddEvidenceRecordSchema.parse({
    schemaVersion: 1,
    disposition: "not_applicable",
    ...input,
  }) as TddException;
}

export function evaluateTddPolicy(input: TddPolicyInput): TddPolicyDecision {
  if (!input.behaviorChanging) return { accepted: true };
  if (!input.evidence) {
    return { accepted: false, reason: "behavior-changing task has no TDD evidence" };
  }
  const evidence = input.evidence;
  if (evidence.taskId !== input.taskId) {
    return { accepted: false, reason: "TDD evidence belongs to a different task" };
  }
  if (
    !sameLinks(evidence.requirements, input.requirements) ||
    !sameLinks(evidence.scenarios, input.scenarios)
  ) {
    return { accepted: false, reason: "TDD evidence is not linked to the task contract" };
  }
  if (evidence.disposition === "not_applicable") return { accepted: true };
  if (evidence.red.exitCode === 0) {
    return { accepted: false, reason: "red-stage check did not fail" };
  }
  if (evidence.green.exitCode !== 0) {
    return { accepted: false, reason: "green-stage check has not passed" };
  }
  if (evidence.refactor.some((check) => check.exitCode !== 0)) {
    return { accepted: false, reason: "post-refactor checks have not passed" };
  }
  return { accepted: true };
}

export async function persistTddEvidence(
  store: AtomicJsonStore,
  evidence: TddEvidenceRecord,
): Promise<void> {
  const validated = tddEvidenceRecordSchema.parse(evidence);
  await store.write(validated.runId, `tdd/${validated.taskId}.json`, validated);
}