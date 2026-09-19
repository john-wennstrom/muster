import { HarnessError } from "../shared/errors.ts";
import type { JsonValue, JudgmentAnswer, JudgmentAnswers, JudgmentQuestions } from "./client.ts";
import {
  COMPLEXITY_QUESTION_IDS,
  capsuleRankingQuestions,
  parseCapsuleRankingQuestionId,
  PREFLIGHT_QUESTION_IDS,
  complexityQuestions,
  parsePreflightCandidateQuestionId,
  preflightQuestions,
  questionsFingerprint,
  validateQuestions,
  type PreflightDisposition,
  type QuestionEntry,
} from "./questions.ts";

/**
 * Decision definitions and their confidence bands. Bands are constants next to the decision
 * that uses them, in this one reviewable place. A gate is pure: answers in, an act-or-abstain
 * outcome out. Abstaining always means the caller does what it does without judgment.
 */

/**
 * What acting can do. The vocabulary has no member that grants a permission, removes a
 * manual checkpoint, or relaxes an existing check; that absence is what "answers never grant
 * permission" means for a reviewer. A decision that can reduce work must abstain into the
 * full, unreduced activity.
 */
export const JUDGMENT_EFFECTS = ["adds_caution", "adds_advice", "reduces_work"] as const;
export type JudgmentEffect = (typeof JUDGMENT_EFFECTS)[number];

export type GateOutcome<Value> =
  | { readonly act: true; readonly value: Value }
  | { readonly act: false; readonly reason: string };

export function act<Value>(value: Value): GateOutcome<Value> {
  return { act: true, value };
}

export function abstain(reason: string): GateOutcome<never> {
  return { act: false, reason };
}

export interface Decision<Input, Value> {
  /** Names the decision in records, fixtures, and summaries; unique in the catalog. */
  readonly id: string;
  /** Bumped whenever question wording or confidence bands change. */
  readonly version: number;
  readonly effects: readonly JudgmentEffect[];
  /** When set, the decision runs only if this variable is also `1`, in the global mode. */
  readonly enabledBy?: string;
  /** Input from which the registry test builds and validates this decision's questions. */
  readonly representativeInput: Input;
  readonly questions: (input: Input) => readonly QuestionEntry[];
  readonly gate: (answers: JudgmentAnswers) => GateOutcome<Value>;
}

export type AnyDecision = Decision<any, unknown>;

export function defineDecision<Input, Value>(
  decision: Decision<Input, Value>,
): Decision<Input, Value> {
  return Object.freeze({ ...decision, effects: Object.freeze([...decision.effects]) });
}

export function decisionKey(decision: Pick<AnyDecision, "id" | "version">): string {
  return `${decision.id}@v${decision.version}`;
}

function invalidDecision(decision: string, message: string): never {
  throw new HarnessError("JUDGMENT_QUESTION_INVALID", `Judgment decision ${decision}: ${message}`, {
    decision,
    question: null,
  });
}

/** Builds a decision's questions from its representative input and validates everything. */
export function validateDecision(decision: AnyDecision): JudgmentQuestions {
  if (!decision.id?.trim()) invalidDecision(String(decision.id), "has an empty identifier");
  if (!Number.isInteger(decision.version) || decision.version < 1) {
    invalidDecision(decision.id, "needs a positive integer version");
  }
  if (!Array.isArray(decision.effects) || decision.effects.length === 0) {
    invalidDecision(decision.id, "does not declare its effects");
  }
  for (const effect of decision.effects) {
    if (!(JUDGMENT_EFFECTS as readonly string[]).includes(effect)) {
      invalidDecision(decision.id, `declares unsupported effect ${String(effect)}`);
    }
  }
  return validateQuestions(decision.id, decision.questions(decision.representativeInput));
}

/** Validates every decision and that identifiers are unique across the catalog. */
export function validateCatalog(decisions: readonly AnyDecision[]): void {
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.id)) invalidDecision(decision.id, "duplicates a decision identifier");
    seen.add(decision.id);
    validateDecision(decision);
  }
}

export function decisionFingerprint(decision: AnyDecision): string {
  return questionsFingerprint(validateDecision(decision));
}

/** Bands for a probability: at or above `yes` acts as yes, at or below `no` as no. */
export function noulBand(value: number, bands: { readonly yes: number; readonly no: number }): "yes" | "no" | "uncertain" {
  if (value >= bands.yes) return "yes";
  if (value <= bands.no) return "no";
  return "uncertain";
}

export function noulOf(answers: JudgmentAnswers, id: string): number | null {
  const answer: JudgmentAnswer | undefined = answers[id];
  return answer?.type === "noul" ? answer.noul : null;
}

export function choiceOf(
  answers: JudgmentAnswers,
  id: string,
): { readonly choice: string; readonly confidence: number } | null {
  const answer: JudgmentAnswer | undefined = answers[id];
  return answer?.type === "choice" ? { choice: answer.choice, confidence: answer.confidence } : null;
}

export function scoreOf(
  answers: JudgmentAnswers,
  id: string,
): { readonly score: number; readonly confidence: number } | null {
  const answer: JudgmentAnswer | undefined = answers[id];
  return answer?.type === "score" ? { score: answer.score, confidence: answer.confidence } : null;
}

/**
 * planning.complexity: which of the four risk inputs to complexity classification a request
 * sets or clears. The gate's value holds only the inputs judged confidently; an input absent
 * from it is uncertain and takes its pattern value. The mechanical and reach answers are
 * recorded with the call and never enter the gate.
 */
export const COMPLEXITY_BANDS = { yes: 0.7, no: 0.3 } as const;

export interface JudgedComplexityInputs {
  hasPublicContractChange?: boolean;
  hasDataMigration?: boolean;
  hasSecurityBoundaryChange?: boolean;
  hasDesignAmbiguity?: boolean;
}

export const COMPLEXITY_SIGNALS = [
  ["hasPublicContractChange", COMPLEXITY_QUESTION_IDS.publicContract],
  ["hasDataMigration", COMPLEXITY_QUESTION_IDS.dataMigration],
  ["hasSecurityBoundaryChange", COMPLEXITY_QUESTION_IDS.securityBoundary],
  ["hasDesignAmbiguity", COMPLEXITY_QUESTION_IDS.designAmbiguity],
] as const satisfies readonly (readonly [keyof JudgedComplexityInputs, string])[];

export interface ComplexityEvidence {
  readonly path: string;
  readonly reason: string;
}

export interface ComplexityInput {
  readonly request: string;
  readonly phase: "propose" | "refine";
  readonly evidence: readonly ComplexityEvidence[];
}

/** The state sent for the call: exactly the request, the phase, and the preflight evidence. */
export function complexityState(input: ComplexityInput): JsonValue {
  return {
    request: input.request,
    phase: input.phase,
    evidence: input.evidence.map(({ path, reason }) => ({ path, reason })),
  };
}

/** Strictly above and strictly below the bands; the edges themselves are uncertain. */
function confidentAnswer(value: number | null): boolean | undefined {
  if (value === null) return undefined;
  if (value > COMPLEXITY_BANDS.yes) return true;
  if (value < COMPLEXITY_BANDS.no) return false;
  return undefined;
}

export const planningComplexityDecision = defineDecision<ComplexityInput, JudgedComplexityInputs>({
  id: "planning.complexity",
  version: 1,
  // A confident yes the pattern missed adds orchestration; a confident no removes it.
  effects: ["adds_caution", "reduces_work"],
  representativeInput: {
    request: "Change the wire format between the broker and the child",
    phase: "propose",
    evidence: [{ path: "src/broker/frame.ts", reason: "Defines the frame layout." }],
  },
  questions: () => complexityQuestions,
  gate: (answers) => {
    const judged: JudgedComplexityInputs = {};
    for (const [key, question] of COMPLEXITY_SIGNALS) {
      const value = confidentAnswer(noulOf(answers, question));
      if (value !== undefined) judged[key] = value;
    }
    return Object.keys(judged).length > 0 ? act(judged) : abstain("no risk input was judged confidently");
  },
});

/**
 * planning.preflight: whether a request should proceed, is already satisfied, or needs
 * clarification, judged over candidate files that code retrieved. Only two outcomes act:
 * a confident proceed, and a confident already-satisfied that at least one candidate
 * corroborates. Clarification never acts, at any confidence, because its whole product is a
 * question that judgment cannot write; the agent runs and writes it. The constants are
 * starting points for calibration.
 */
export const PREFLIGHT_CONFIDENCE_FLOOR = 0.8;
export const PREFLIGHT_CORROBORATION_FLOOR = 0.7;
export const PREFLIGHT_RELEVANCE_FLOOR = 0.5;

export interface PreflightCandidateInput {
  readonly path: string;
  readonly excerpt: string;
}

export interface PreflightInput {
  readonly request: string;
  readonly candidates: readonly PreflightCandidateInput[];
}

/** The state sent for the call: exactly the request and each candidate's path and excerpt. */
export function preflightState(input: PreflightInput): JsonValue {
  return {
    request: input.request,
    candidates: input.candidates.map(({ path, excerpt }, position) => ({
      index: position + 1,
      path,
      excerpt,
    })),
  };
}

export interface PreflightCandidateAnswer {
  /** One-based, matching the candidate's index in the state. */
  readonly index: number;
  /** Probability that the candidate already implements the request. */
  readonly implements: number;
  /** Probability that the candidate would need to change. */
  readonly needsChange: number;
  /** The higher of the two: how likely the candidate matters to the request at all. */
  readonly relevance: number;
}

/** The per-candidate answers, in candidate order; a candidate missing either answer is left out. */
export function preflightCandidateAnswers(answers: JudgmentAnswers): PreflightCandidateAnswer[] {
  const partial = new Map<number, { implements?: number; needsChange?: number }>();
  for (const id of Object.keys(answers)) {
    const parsed = parsePreflightCandidateQuestionId(id);
    const value = noulOf(answers, id);
    if (!parsed || value === null) continue;
    const entry = partial.get(parsed.index) ?? {};
    if (parsed.kind === "implements") entry.implements = value;
    else entry.needsChange = value;
    partial.set(parsed.index, entry);
  }
  return [...partial.entries()]
    .filter((pair): pair is [number, Required<{ implements: number; needsChange: number }>] =>
      pair[1].implements !== undefined && pair[1].needsChange !== undefined)
    .sort(([left], [right]) => left - right)
    .map(([index, { implements: implemented, needsChange }]) => ({
      index,
      implements: implemented,
      needsChange,
      relevance: Math.max(implemented, needsChange),
    }));
}

export interface PreflightGateValue {
  readonly disposition: Exclude<PreflightDisposition, "needs_clarification">;
  readonly confidence: number;
  readonly candidates: readonly PreflightCandidateAnswer[];
}

export const planningPreflightDecision = defineDecision<PreflightInput, PreflightGateValue>({
  id: "planning.preflight",
  version: 1,
  // Acting skips a mandatory agent run, so every abstention falls through to that run.
  effects: ["reduces_work"],
  representativeInput: {
    request: "Retry `parseInvoice` when the invoice_total is missing",
    candidates: [
      { path: "src/billing/invoice.ts", excerpt: "12: export function parseInvoice(input) {" },
      { path: "src/billing/retry.ts", excerpt: "3: export function withRetry(work) {" },
    ],
  },
  questions: (input) => preflightQuestions(input.candidates.length),
  gate: (answers) => {
    const disposition = choiceOf(answers, PREFLIGHT_QUESTION_IDS.disposition);
    if (!disposition) return abstain("no disposition was judged");
    if (disposition.choice === "needs_clarification") {
      return abstain("clarification is written by the agent, never decided by judgment alone");
    }
    if (disposition.choice !== "proceed" && disposition.choice !== "already_satisfied") {
      return abstain(`unrecognized disposition ${disposition.choice}`);
    }
    if (disposition.confidence < PREFLIGHT_CONFIDENCE_FLOOR) {
      return abstain(`${disposition.choice} confidence ${disposition.confidence} is below ${PREFLIGHT_CONFIDENCE_FLOOR}`);
    }
    const candidates = preflightCandidateAnswers(answers);
    if (
      disposition.choice === "already_satisfied"
      && !candidates.some((candidate) => candidate.implements > PREFLIGHT_CORROBORATION_FLOOR)
    ) {
      return abstain("no candidate is judged to implement the request");
    }
    return act({ disposition: disposition.choice, confidence: disposition.confidence, candidates });
  },
});

/**
 * context.capsule_ranking: how necessary each of a task's relevant slices is, on a rubric of
 * unrelated (0), background (1), useful (2), and required (3). The answer is an expectation
 * that can fall between levels, so every threshold is a comparison against it and nothing
 * interpolates it into a magnitude. The gate returns every scored slice; what to do with a
 * score is the assembler's and the escalation check's business, using the bands below. The
 * bands are starting points for calibration.
 */
export const CAPSULE_DEMOTE_BELOW = 0.5;
export const CAPSULE_DEMOTE_CONFIDENCE = 0.7;
export const CAPSULE_OVERSIZED_AT = 2.5;
export const CAPSULE_OVERSIZED_CONFIDENCE = 0.7;
export const CAPSULE_AUTHORIZE_AT = 1.5;
export const CAPSULE_AUTHORIZE_CONFIDENCE = 0.6;

export interface CapsuleRankingSliceInput {
  /** Repository-relative path of a file-backed slice, when it has one. */
  readonly path?: string;
  /** At most 600 bytes of the slice's content. */
  readonly excerpt: string;
}

export interface CapsuleRankingInput {
  /** The task contract, rendered as the fields the builder is given. */
  readonly task: {
    readonly definition: string;
    readonly requirements: readonly string[];
    readonly scenarios: readonly string[];
    readonly decisions: readonly string[];
    readonly readScopes: readonly string[];
    readonly writeScopes: readonly string[];
    readonly acceptance: readonly string[];
  };
  readonly slices: readonly CapsuleRankingSliceInput[];
}

/** The state sent for the call: exactly the task contract and each slice's path and excerpt. */
export function capsuleRankingState(input: CapsuleRankingInput): JsonValue {
  return {
    task: {
      definition: input.task.definition,
      requirements: [...input.task.requirements],
      scenarios: [...input.task.scenarios],
      decisions: [...input.task.decisions],
      readScopes: [...input.task.readScopes],
      writeScopes: [...input.task.writeScopes],
      acceptance: [...input.task.acceptance],
    },
    slices: input.slices.map(({ path, excerpt }, position) => ({
      index: position + 1,
      ...(path === undefined ? {} : { path }),
      excerpt,
    })),
  };
}

export interface CapsuleRankingSliceAnswer {
  /** One-based, matching the slice's index in the state. */
  readonly index: number;
  readonly score: number;
  readonly confidence: number;
}

export interface CapsuleRankingGateValue {
  readonly slices: readonly CapsuleRankingSliceAnswer[];
}

/** Every scored slice, in slice order; a slice whose answer is missing or not a score is left out. */
export function capsuleRankingAnswers(answers: JudgmentAnswers): CapsuleRankingSliceAnswer[] {
  const scored: CapsuleRankingSliceAnswer[] = [];
  for (const id of Object.keys(answers)) {
    const index = parseCapsuleRankingQuestionId(id);
    const answer = scoreOf(answers, id);
    if (index === null || !answer || !Number.isFinite(answer.score) || !Number.isFinite(answer.confidence)) continue;
    scored.push({ index, score: answer.score, confidence: answer.confidence });
  }
  return scored.sort((left, right) => left.index - right.index);
}

export const contextCapsuleRankingDecision = defineDecision<CapsuleRankingInput, CapsuleRankingGateValue>({
  id: "context.capsule_ranking",
  version: 1,
  // Demoting a confidently unrelated slice reduces what a builder is given; ordering advises
  // which context to prioritize. Uncertainty demotes nothing and leaves list order alone.
  effects: ["reduces_work", "adds_advice"],
  representativeInput: {
    task: {
      definition: "Retry `parseInvoice` when the invoice_total is missing",
      requirements: ["A missing invoice_total is retried once"],
      scenarios: ["Missing total is retried"],
      decisions: ["Retries reuse the existing withRetry helper"],
      readScopes: ["src/billing/**"],
      writeScopes: ["src/billing/**", "tests/billing/**"],
      acceptance: ["Focused tests pass"],
    },
    slices: [
      { path: "src/billing/invoice.ts", excerpt: "12: export function parseInvoice(input) {" },
      { excerpt: "Design note: retries use the shared helper." },
    ],
  },
  questions: (input) => capsuleRankingQuestions(input.slices.length),
  gate: (answers) => {
    const slices = capsuleRankingAnswers(answers);
    return slices.length > 0 ? act({ slices }) : abstain("no slice was scored");
  },
});

/**
 * Every decision the harness can ask. Later changes append here; none modifies another's.
 */
export const judgmentCatalog: readonly AnyDecision[] = [
  planningComplexityDecision,
  planningPreflightDecision,
  contextCapsuleRankingDecision,
];
