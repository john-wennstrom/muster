import { truncateBytes } from "../context/candidates.ts";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import {
  listDecisionRecords,
  reconcileDecisionRecord,
  type DecisionRecord,
} from "../judgment/audit.ts";
import type { JudgmentUnavailableReason } from "../judgment/client.ts";
import {
  THRASH_HUMAN_NEEDED_ABOVE,
  THRASH_NO_PROGRESS_BELOW,
  THRASH_SAME_CAUSE_ABOVE,
  debuggingThrashDecision,
  thrashState,
  type ThrashFailureInput,
  type ThrashGateValue,
  type ThrashInput,
} from "../judgment/gates.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { HarnessError } from "../shared/errors.ts";
import {
  debuggingStateSchema,
  type DebuggingState,
  type FailureAssessment,
} from "./debugging.ts";

/**
 * Repair progress: the pure half of judging whether a repair loop is converging. Everything
 * here only ever shortens a loop. Nothing raises the threshold, delays systematic debugging,
 * or re-enables ordinary repair, so whatever the answers are, the attempt at which a task
 * moves to systematic debugging is never later than the count would have made it.
 */

export type RepairPath =
  | { readonly kind: "continue" }
  | { readonly kind: "escalate"; readonly reason: string }
  | { readonly kind: "await_user"; readonly reason: string };

export type AssessmentReading = Pick<FailureAssessment, "sameRootCause" | "progress" | "humanNeeded">;
type AssessedRound = AssessmentReading & { readonly attempt: number };

/** The failures share a root cause and the attempted fix made no progress. */
export function isStalledRound(reading: Pick<AssessmentReading, "sameRootCause" | "progress">): boolean {
  return reading.sameRootCause > THRASH_SAME_CAUSE_ABOVE && reading.progress < THRASH_NO_PROGRESS_BELOW;
}

function invalid(message: string, state: DebuggingState): never {
  throw new HarnessError("DEBUGGING_STATE_INVALID", message, {
    taskId: state.taskId,
    failures: state.failures.length,
    threshold: state.threshold,
  });
}

/** Records an assessment of the latest failure. It needs a prior failure and a single assessment per failure. */
export function appendAssessment(
  state: DebuggingState,
  assessment: AssessmentReading & Pick<FailureAssessment, "recordId" | "recordedAt">,
): DebuggingState {
  const current = debuggingStateSchema.parse(state);
  const attempt = current.failures.length;
  if (attempt < 2) return invalid("An assessment needs at least two recorded failures", current);
  if (current.assessments?.some((existing) => existing.attempt === attempt)) {
    return invalid("The latest failure has already been assessed", current);
  }
  return debuggingStateSchema.parse({
    ...current,
    assessments: [...(current.assessments ?? []), { ...assessment, attempt }],
    updatedAt: assessment.recordedAt,
  });
}

/** The two most recent assessments when they follow consecutive failures, oldest first. */
function consecutiveRounds(
  state: DebuggingState,
  latest: AssessedRound,
): readonly [previous: AssessedRound, latest: AssessedRound] | null {
  const previous = state.assessments?.find((assessment) => assessment.attempt === latest.attempt - 1);
  return previous ? [previous, latest] : null;
}

/**
 * The next path for a loop, from its state and the latest assessment. Awaiting the user takes
 * precedence over everything, including a stalled pair of rounds. Escalation needs two
 * consecutive stalled rounds and a task still below its threshold in ordinary repair.
 */
export function decideRepairPath(
  state: DebuggingState,
  latest: AssessedRound,
): RepairPath {
  const current = debuggingStateSchema.parse(state);
  if (latest.humanNeeded > THRASH_HUMAN_NEEDED_ABOVE) {
    return {
      kind: "await_user",
      reason: "The failure appears to need a decision, a credential, or access an automated agent cannot obtain",
    };
  }
  if (current.mode !== "ordinary_repair" || current.failures.length >= current.threshold) {
    return { kind: "continue" };
  }
  const rounds = consecutiveRounds(current, latest);
  if (rounds && rounds.every(isStalledRound)) {
    return {
      kind: "escalate",
      reason: `Attempts ${rounds[0].attempt} and ${rounds[1].attempt} failed for the same root cause without progress`,
    };
  }
  return { kind: "continue" };
}

/**
 * Moves a task to systematic debugging before its threshold. Refuses unless the two latest
 * assessments follow consecutive failures, both stalled, and the threshold has not been
 * reached, so a caller cannot use it to do anything the decision function would not.
 */
export function applyEarlyEscalation(
  state: DebuggingState,
  escalation: { readonly reason: string; readonly recordId: string | null; readonly recordedAt: string },
): DebuggingState {
  const current = debuggingStateSchema.parse(state);
  if (current.mode !== "ordinary_repair" || current.failures.length >= current.threshold) {
    return invalid("Early escalation is only possible in ordinary repair below the threshold", current);
  }
  const latest = current.assessments?.at(-1);
  const rounds = latest && latest.attempt === current.failures.length ? consecutiveRounds(current, latest) : null;
  if (!rounds || !rounds.every(isStalledRound)) {
    return invalid("Early escalation needs two consecutive stalled assessments", current);
  }
  return debuggingStateSchema.parse({
    ...current,
    mode: "systematic_debugging",
    escalation: { ...escalation, attempt: current.failures.length },
    updatedAt: escalation.recordedAt,
  });
}

/** Failure text is excerpted here, by the caller, because the judgment layer never truncates. */
export const THRASH_EVIDENCE_BYTES = 2_000;
export const THRASH_REPRODUCTION_BYTES = 1_000;
export const THRASH_ATTEMPTED_FIX_BYTES = 2_000;

/** Keeps a text within a byte limit, marking the cut, so the result never exceeds the limit. */
function excerpt(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return `${truncateBytes(text, limit - Buffer.byteLength("…", "utf8"))}…`;
}

function boundedFailure(failure: DebuggingState["failures"][number]): ThrashFailureInput {
  return {
    attempt: failure.attempt,
    reproduction: excerpt(failure.reproduction, THRASH_REPRODUCTION_BYTES),
    evidence: failure.evidence.map((item) => excerpt(item, THRASH_EVIDENCE_BYTES)),
  };
}

/** The judgment input for a state, or why it is not assessed: two failures and an attempted fix are required. */
export function buildThrashInput(
  state: DebuggingState,
  taskDefinition: string,
): { readonly ok: true; readonly input: ThrashInput } | { readonly ok: false; readonly reason: "too_few_failures" | "no_attempted_fix" } {
  const latest = state.failures.at(-1);
  const previous = state.failures.at(-2);
  if (!latest || !previous) return { ok: false, reason: "too_few_failures" };
  if (!latest.attemptedFix) return { ok: false, reason: "no_attempted_fix" };
  return {
    ok: true,
    input: {
      taskDefinition,
      previous: boundedFailure(previous),
      latest: { ...boundedFailure(latest), attemptedFix: excerpt(latest.attemptedFix, THRASH_ATTEMPTED_FIX_BYTES) },
    },
  };
}

export type RepairAssessment =
  | {
      readonly assessed: false;
      readonly reason:
        | "too_few_failures"
        | "no_attempted_fix"
        | "already_assessed"
        | "abstained"
        | "unrecorded"
        | JudgmentUnavailableReason;
      /** Unchanged: transitions follow the count. */
      readonly state: DebuggingState;
      readonly path: { readonly kind: "continue" };
    }
  | {
      readonly assessed: true;
      /** With the assessment appended, and with the escalation applied only in enforce mode. */
      readonly state: DebuggingState;
      /** What the caller acts on: always continue in shadow mode. */
      readonly path: RepairPath;
      /** What judgment decided, which in shadow mode is what enforce would have done. */
      readonly decided: RepairPath;
      readonly mode: "shadow" | "enforce";
      readonly recordId: string | null;
    };

export const THRASH_PATH_KEY = "path";
export const THRASH_ATTEMPT_KEY = "attempt";
export const THRASH_OUTCOME_KEY = "outcome";

function isGateValue(value: unknown): value is ThrashGateValue {
  if (!value || typeof value !== "object") return false;
  const { sameRootCause, progress, humanNeeded } = value as Record<string, unknown>;
  return [sameRootCause, progress, humanNeeded].every((item) =>
    typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1);
}

/** A shadow verdict carries no outcome, so its reading is taken from the record it wrote. */
async function recordedReading(
  store: AtomicJsonStore,
  changeName: string,
  recordId: string,
): Promise<ThrashGateValue | null> {
  const record: DecisionRecord | undefined = (await listDecisionRecords(store, changeName))
    .find((candidate) => candidate.recordId === recordId);
  return record?.gate?.act && isGateValue(record.gate.value) ? record.gate.value : null;
}

/**
 * Assesses the latest failure of a repair loop, after it is recorded. Every way of not
 * assessing returns the state untouched, so transitions follow the count exactly as without
 * judgment. The assessment is stored in both modes because it is an observation; an early
 * escalation is applied only in enforce mode, and only when the pure functions allow it.
 */
export async function assessRepairProgress(input: {
  readonly runtime: JudgmentRuntime;
  readonly store: AtomicJsonStore;
  readonly changeName: string;
  readonly taskDefinition: string;
  readonly state: DebuggingState;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}): Promise<RepairAssessment> {
  const state = debuggingStateSchema.parse(input.state);
  const skipped = (reason: Extract<RepairAssessment, { assessed: false }>["reason"]): RepairAssessment =>
    ({ assessed: false, reason, state, path: { kind: "continue" } });

  if (!input.runtime.enabled) return skipped("disabled");
  const built = buildThrashInput(state, input.taskDefinition);
  if (!built.ok) return skipped(built.reason);
  if (state.assessments?.some((assessment) => assessment.attempt === state.failures.length)) {
    return skipped("already_assessed");
  }

  const verdict = await input.runtime.judge(debuggingThrashDecision, {
    input: built.input,
    changeName: input.changeName,
    phase: "implementation",
    taskId: state.taskId,
    state: thrashState(built.input),
    signal: input.signal,
    deadlineMs: input.deadlineMs,
  });
  if (verdict.kind === "fallback") return skipped(verdict.reason);

  let reading: ThrashGateValue | null = null;
  if (verdict.kind === "enforce") {
    if (!verdict.outcome.act) return skipped("abstained");
    reading = verdict.outcome.value;
  } else if (verdict.recordId !== null) {
    try {
      reading = await recordedReading(input.store, input.changeName, verdict.recordId);
    } catch {
      reading = null;
    }
  }
  if (!reading) return skipped("unrecorded");

  const recordedAt = (input.now ?? (() => new Date()))().toISOString();
  const assessed = appendAssessment(state, { ...reading, recordId: verdict.recordId, recordedAt });
  const latest = assessed.assessments!.at(-1)!;
  const decided = decideRepairPath(assessed, latest);
  const mode = verdict.kind;

  if (verdict.recordId !== null) {
    try {
      await reconcileDecisionRecord(input.store, input.changeName, verdict.recordId, {
        observed: { [THRASH_PATH_KEY]: decided.kind, [THRASH_ATTEMPT_KEY]: latest.attempt },
      });
    } catch {
      // Measurement only; failing to write it must not change the loop.
    }
  }

  if (mode === "shadow") {
    return { assessed: true, state: assessed, path: { kind: "continue" }, decided, mode, recordId: verdict.recordId };
  }
  const next = decided.kind === "escalate"
    ? applyEarlyEscalation(assessed, { reason: decided.reason, recordId: verdict.recordId, recordedAt })
    : assessed;
  return { assessed: true, state: next, path: decided, decided, mode, recordId: verdict.recordId };
}

/**
 * Records what became of a task on every decision made for it, so the fairness of early
 * escalation can be read back: whether tasks the decision would have cut short went on to pass.
 * Reconciliation is measurement, and a failure to write it never reaches the caller.
 */
export async function reconcileRepairOutcome(input: {
  readonly store: AtomicJsonStore;
  readonly changeName: string;
  readonly state: DebuggingState;
  readonly status: "passed" | "exhausted";
  /** The attempt at which the task passed or ran out of attempts. */
  readonly attempt: number;
}): Promise<void> {
  for (const assessment of input.state.assessments ?? []) {
    if (assessment.recordId === null) continue;
    try {
      await reconcileDecisionRecord(input.store, input.changeName, assessment.recordId, {
        observed: { [THRASH_OUTCOME_KEY]: { status: input.status, attempt: input.attempt } },
      });
    } catch {
      // See above.
    }
  }
}
