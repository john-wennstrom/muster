import { HarnessError } from "../shared/errors.ts";
import type { JsonValue, JudgmentAnswer, JudgmentAnswers, JudgmentQuestions } from "./client.ts";
import {
  COMMAND_CATEGORIES,
  COMMAND_QUESTION_IDS,
  COMPLEXITY_QUESTION_IDS,
  capsuleRankingQuestions,
  commandQuestions,
  parseCapsuleRankingQuestionId,
  PREFLIGHT_QUESTION_IDS,
  REVIEW_EXTRACTION_LINE_KINDS,
  REVIEW_EXTRACTION_QUESTION_IDS,
  REVIEW_EXTRACTION_VERDICTS,
  REVIEW_TRIAGE_CHANGE_QUESTION_IDS,
  REVIEW_TRIAGE_QUESTION_IDS,
  TASK_FOCUS_QUESTION_IDS,
  TASK_ROUTING_QUESTION_IDS,
  TASK_ROUTING_RISK_QUESTION_IDS,
  THRASH_QUESTION_IDS,
  TASK_QUALITY_COVERAGE_QUESTION_ID,
  TASK_QUALITY_KINDS,
  complexityQuestions,
  parsePreflightCandidateQuestionId,
  parseReviewExtractionLineQuestionId,
  parseTaskQualityQuestionId,
  preflightQuestions,
  reviewExtractionQuestions,
  reviewTriageQuestions,
  questionsFingerprint,
  taskFocusQuestions,
  taskRoutingQuestions,
  taskQualityQuestions,
  thrashQuestions,
  validateQuestions,
  type PreflightDisposition,
  type QuestionEntry,
  type ReviewExtractionLineKind,
  type TaskQualityKind,
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
 * review.task_focus: which areas of a task's diff deserve the reviewer's attention first. Each
 * answer past its threshold selects one fixed catalogue phrase; nothing a model wrote reaches
 * the reviewer. A question that a good change answers yes to speaks when its answer falls
 * below `TASK_FOCUS_BANDS.no`; one that a good change answers no to speaks above
 * `TASK_FOCUS_BANDS.yes`; the reach rubric speaks at `TASK_FOCUS_REACH_AT` with at least
 * `TASK_FOCUS_REACH_CONFIDENCE`. Anything between the bands is uncertain and adds nothing, so
 * uncertainty costs the reviewer no attention. At most `TASK_FOCUS_MAX_ITEMS` items are kept,
 * in the order of `TASK_FOCUS_CATALOGUE`, which runs from most to least consequential. The
 * thresholds are starting points for calibration.
 */
export const TASK_FOCUS_BANDS = { yes: 0.7, no: 0.3 } as const;
export const TASK_FOCUS_REACH_AT = 2.0;
export const TASK_FOCUS_REACH_CONFIDENCE = 0.7;
export const TASK_FOCUS_MAX_ITEMS = 4;

/** The review areas a finding can be raised in, as the reviewer's schema names them. */
export type TaskFocusArea = "contract" | "diff" | "tests" | "scopes" | "tdd";

interface TaskFocusEntry {
  readonly id: string;
  readonly phrase: string;
  /** The reviewer's finding area this phrase points at, used to reconcile after the review. */
  readonly area: TaskFocusArea;
  readonly speaks: (answers: JudgmentAnswers) => boolean;
}

const speaksWhenFalse = (id: string) => (answers: JudgmentAnswers): boolean => {
  const value = noulOf(answers, id);
  return value !== null && value < TASK_FOCUS_BANDS.no;
};

const speaksWhenTrue = (id: string) => (answers: JudgmentAnswers): boolean => {
  const value = noulOf(answers, id);
  return value !== null && value > TASK_FOCUS_BANDS.yes;
};

/** In priority order: most consequential first. */
export const TASK_FOCUS_CATALOGUE: readonly TaskFocusEntry[] = [
  {
    id: TASK_FOCUS_QUESTION_IDS.securityBoundary,
    phrase: "Whether the diff changes what is allowed or trusted: permissions, credentials, or validation of untrusted input",
    area: "diff",
    speaks: speaksWhenTrue(TASK_FOCUS_QUESTION_IDS.securityBoundary),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.scopeContainment,
    phrase: "Whether every changed file is inside the authorized write scopes",
    area: "scopes",
    speaks: speaksWhenFalse(TASK_FOCUS_QUESTION_IDS.scopeContainment),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.contractMatch,
    phrase: "Whether the diff implements what the task contract's requirements describe",
    area: "contract",
    speaks: speaksWhenFalse(TASK_FOCUS_QUESTION_IDS.contractMatch),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.scenarioCoverage,
    phrase: "Whether the tests exercise each of the task's scenarios",
    area: "tests",
    speaks: speaksWhenFalse(TASK_FOCUS_QUESTION_IDS.scenarioCoverage),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.testFirstConsistency,
    phrase: "Whether the test-first evidence is consistent with the diff",
    area: "tdd",
    speaks: speaksWhenFalse(TASK_FOCUS_QUESTION_IDS.testFirstConsistency),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.stubOrHardcoded,
    phrase: "Whether the diff adds a stub, placeholder, or hard-coded value in place of real behavior",
    area: "diff",
    speaks: speaksWhenTrue(TASK_FOCUS_QUESTION_IDS.stubOrHardcoded),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.reach,
    phrase: "Whether code outside the diff depends on behavior the diff changes",
    area: "diff",
    speaks: (answers) => {
      const value = scoreOf(answers, TASK_FOCUS_QUESTION_IDS.reach);
      return value !== null
        && Number.isFinite(value.score)
        && value.score >= TASK_FOCUS_REACH_AT
        && value.confidence >= TASK_FOCUS_REACH_CONFIDENCE;
    },
  },
];

export interface TaskFocusInput {
  /** The task contract as the reviewer receives it. */
  readonly contract: {
    readonly definition: string;
    readonly requirements: readonly string[];
    readonly scenarios: readonly string[];
  };
  /** The leading part of the diff, at most 24,000 bytes, cut at a file boundary. */
  readonly diffExcerpt: string;
  /** Every path the diff changes, whether or not the excerpt reaches it. */
  readonly changedPaths: readonly string[];
  readonly tests: readonly string[];
  readonly scopes: { readonly reads: readonly string[]; readonly writes: readonly string[] };
  readonly tddEvidence: unknown;
}

/** The state sent for the call: exactly the review inputs, with the diff excerpted. */
export function taskFocusState(input: TaskFocusInput): JsonValue {
  return {
    contract: {
      definition: input.contract.definition,
      requirements: [...input.contract.requirements],
      scenarios: [...input.contract.scenarios],
    },
    diffExcerpt: input.diffExcerpt,
    changedPaths: [...input.changedPaths],
    tests: [...input.tests],
    scopes: { reads: [...input.scopes.reads], writes: [...input.scopes.writes] },
    tddEvidence: (input.tddEvidence ?? null) as JsonValue,
  };
}

export interface TaskFocusItem {
  readonly id: string;
  /** Always one of the catalogue's phrases. */
  readonly phrase: string;
  readonly area: TaskFocusArea;
}

export interface TaskFocusGateValue {
  readonly items: readonly TaskFocusItem[];
}

export const reviewTaskFocusDecision = defineDecision<TaskFocusInput, TaskFocusGateValue>({
  id: "review.task_focus",
  version: 1,
  // The focus list is advice to a reviewer that still runs and still decides.
  effects: ["adds_advice"],
  representativeInput: {
    contract: {
      definition: "Retry `parseInvoice` when the invoice_total is missing",
      requirements: ["A missing invoice_total is retried once"],
      scenarios: ["Missing total is retried"],
    },
    diffExcerpt: "diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts\n+  return withRetry(parse);",
    changedPaths: ["src/billing/invoice.ts", "tests/billing/invoice.test.ts"],
    tests: ["bun test tests/billing/invoice.test.ts: pass"],
    scopes: { reads: ["src/billing/**"], writes: ["src/billing/**", "tests/billing/**"] },
    tddEvidence: { disposition: "required", stages: ["red", "green", "refactor"] },
  },
  questions: () => taskFocusQuestions,
  gate: (answers) => {
    const items = TASK_FOCUS_CATALOGUE
      .filter((entry) => entry.speaks(answers))
      .slice(0, TASK_FOCUS_MAX_ITEMS)
      .map(({ id, phrase, area }): TaskFocusItem => ({ id, phrase, area }));
    return items.length > 0 ? act({ items }) : abstain("no check crossed its threshold");
  },
});

/**
 * command.classification: which manual-approval category, if any, a host command belongs to.
 * The category choice alone drives the gate: any category other than none acts, at any
 * confidence, because an uncertain classifier on a question about destructive or external
 * effects is itself a reason to involve a human. None abstains, and the caller then does what
 * it does without judgment. The three yes/no answers are recorded and never enter the
 * outcome; using them to add categories would raise sensitivity before any data exists. The
 * value's category vocabulary is defined here, not imported from the tools layer, and matches
 * the manual-action categories it is later handed to.
 */
export const COMMAND_UNCERTAIN_NONE_BELOW = 0.7;
export const COMMAND_UNCERTAIN_NONE_REASON = "none judged with low confidence";

export type JudgedCommandCategory = Exclude<(typeof COMMAND_CATEGORIES)[number], "none">;

export interface CommandClassificationInput {
  readonly executable: string;
  readonly args: readonly string[];
  /** The working directory relative to the worktree, "." at its root. */
  readonly cwd: string;
  readonly profile: string;
}

/** The state sent for the call: exactly the command's shape, and never the environment or a file. */
export function commandState(input: CommandClassificationInput): JsonValue {
  return {
    executable: input.executable,
    args: [...input.args],
    cwd: input.cwd,
    profile: input.profile,
  };
}

export interface CommandGateValue {
  readonly category: JudgedCommandCategory;
  readonly confidence: number;
}

export const commandClassificationDecision = defineDecision<CommandClassificationInput, CommandGateValue>({
  id: "command.classification",
  version: 1,
  // A judged category only adds a manual-approval requirement; none abstains into today's path.
  effects: ["adds_caution"],
  representativeInput: {
    executable: "npm",
    args: ["run", "deploy", "--", "--env", "production"],
    cwd: ".",
    profile: "verification",
  },
  questions: () => commandQuestions,
  gate: (answers) => {
    const category = choiceOf(answers, COMMAND_QUESTION_IDS.category);
    if (!category) return abstain("no category was judged");
    if (category.choice === "none") {
      return abstain(
        category.confidence < COMMAND_UNCERTAIN_NONE_BELOW
          ? `${COMMAND_UNCERTAIN_NONE_REASON} (${category.confidence})`
          : "none",
      );
    }
    if (!isJudgedCommandCategory(category.choice)) {
      return abstain(`unrecognized category ${category.choice}`);
    }
    return act({ category: category.choice, confidence: category.confidence });
  },
});

function isJudgedCommandCategory(choice: string): choice is JudgedCommandCategory {
  return choice !== "none" && (COMMAND_CATEGORIES as readonly string[]).includes(choice);
}

/** Whether a gate's abstention was a none the service was unsure of, for calibration. */
export function isUncertainNone(reason: string): boolean {
  return reason.startsWith(COMMAND_UNCERTAIN_NONE_REASON);
}

/**
 * review.extraction: whether a reviewer's prose response can stand in for the structured
 * review it failed to return, by classifying its own lines. The gate acts only when the whole
 * extraction is confident and internally consistent: the verdict is confident and not unclear,
 * every line is confidently classified, an approval has no critical or required line, and a
 * revise has at least one. The consistency check runs in both directions because a false
 * approval lets a flawed plan proceed, whereas a false revise costs one refine cycle. Requiring
 * every line to be confident, for both verdicts, errs toward the corrective retry, which is
 * what abstaining means here. The floor is a starting point for calibration.
 */
export const REVIEW_EXTRACTION_CONFIDENCE_FLOOR = 0.8;

export interface ReviewExtractionCandidateInput {
  /** One-based, matching the line's index in the state. */
  readonly index: number;
  /** The nearest heading above the line, or null when there is none. */
  readonly heading: string | null;
  readonly text: string;
}

export interface ReviewExtractionInput {
  /** The reviewer's response text, at most 24,000 bytes. */
  readonly response: string;
  readonly candidates: readonly ReviewExtractionCandidateInput[];
}

/** The state sent for the call: exactly the response and its candidate lines. */
export function reviewExtractionState(input: ReviewExtractionInput): JsonValue {
  return {
    response: input.response,
    candidates: input.candidates.map(({ index, heading, text }) => ({ index, heading, text })),
  };
}

export interface ReviewExtractionLineAnswer {
  /** One-based, matching the line's index in the state. */
  readonly index: number;
  readonly kind: ReviewExtractionLineKind;
  readonly confidence: number;
}

export interface ReviewExtractionGateValue {
  readonly verdict: "approve" | "revise";
  readonly verdictConfidence: number;
  /** Every classified line, in line order. */
  readonly lines: readonly ReviewExtractionLineAnswer[];
}

const isLineKind = (choice: string): choice is ReviewExtractionLineKind =>
  (REVIEW_EXTRACTION_LINE_KINDS as readonly string[]).includes(choice);

const isBlocking = (kind: ReviewExtractionLineKind): boolean => kind === "critical" || kind === "required";

export const reviewExtractionDecision = defineDecision<ReviewExtractionInput, ReviewExtractionGateValue>({
  id: "review.extraction",
  version: 1,
  // Acting skips a corrective retry, so every abstention falls through to that retry.
  effects: ["reduces_work"],
  representativeInput: {
    response: "The plan is sound.\n\n- The migration step has no rollback.\n- Consider a shorter task list.",
    candidates: [
      { index: 1, heading: null, text: "The plan is sound." },
      { index: 2, heading: null, text: "The migration step has no rollback." },
      { index: 3, heading: null, text: "Consider a shorter task list." },
    ],
  },
  questions: (input) => reviewExtractionQuestions(input.candidates.length),
  gate: (answers) => {
    const verdict = choiceOf(answers, REVIEW_EXTRACTION_QUESTION_IDS.verdict);
    if (!verdict) return abstain("no verdict was judged");
    if (verdict.choice === "unclear") return abstain("the verdict is unclear");
    if (!(REVIEW_EXTRACTION_VERDICTS as readonly string[]).includes(verdict.choice)) {
      return abstain(`unrecognized verdict ${verdict.choice}`);
    }
    if (verdict.confidence < REVIEW_EXTRACTION_CONFIDENCE_FLOOR) {
      return abstain(`${verdict.choice} confidence ${verdict.confidence} is below ${REVIEW_EXTRACTION_CONFIDENCE_FLOOR}`);
    }

    const lines: ReviewExtractionLineAnswer[] = [];
    for (const id of Object.keys(answers)) {
      const index = parseReviewExtractionLineQuestionId(id);
      if (index === null) continue;
      const line = choiceOf(answers, id);
      if (!line) return abstain(`line ${index} was not classified`);
      if (!isLineKind(line.choice)) return abstain(`line ${index} has unrecognized kind ${line.choice}`);
      if (line.confidence < REVIEW_EXTRACTION_CONFIDENCE_FLOOR) {
        return abstain(`line ${index} confidence ${line.confidence} is below ${REVIEW_EXTRACTION_CONFIDENCE_FLOOR}`);
      }
      lines.push({ index, kind: line.choice, confidence: line.confidence });
    }
    if (lines.length === 0) return abstain("no line was classified");
    lines.sort((left, right) => left.index - right.index);

    const blocking = lines.some((line) => isBlocking(line.kind));
    if (verdict.choice === "approve" && blocking) return abstain("approve with a critical or required line");
    if (verdict.choice === "revise" && !blocking) return abstain("revise with no critical or required line");
    return act({
      verdict: verdict.choice as "approve" | "revise",
      verdictConfidence: verdict.confidence,
      lines,
    });
  },
});

/**
 * planning.task_quality: advisory findings about a synthesized task list, from one call over
 * every task. A question whose good answer is yes speaks below `TASK_QUALITY_BANDS.no`, and one
 * whose good answer is no speaks above `TASK_QUALITY_BANDS.yes`; the size rubric speaks at
 * `TASK_QUALITY_SIZE_AT` with at least `TASK_QUALITY_SIZE_CONFIDENCE`; coverage speaks like a
 * good-yes question. Anything between the bands is uncertain and produces nothing, so
 * uncertainty costs nobody attention. A finding is a kind, a task, and a probability; its text
 * is a fixed template filled in by code, so nothing a model wrote reaches a person or a
 * reviewer. The thresholds are starting points for calibration.
 */
export const TASK_QUALITY_BANDS = { yes: 0.7, no: 0.3 } as const;
export const TASK_QUALITY_SIZE_AT = 2.5;
export const TASK_QUALITY_SIZE_CONFIDENCE = 0.7;
/** Findings the planning outcome lists, highest probability first; the total is always stated. */
export const TASK_QUALITY_MAX_DISPLAYED = 8;

/** Keys a record's observations use for the plan-time digest, the task order, and each task's outcome. */
export const TASK_QUALITY_DIGEST_KEY = "definitionDigest";
export const TASK_QUALITY_TASK_IDS_KEY = "taskIds";
export const TASK_QUALITY_OUTCOME_PREFIX = "outcome:";
export const taskQualityOutcomeKey = (taskId: string): string => `${TASK_QUALITY_OUTCOME_PREFIX}${taskId}`;

export interface TaskQualityTaskInput {
  readonly id: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly verify: readonly string[];
}

export interface TaskQualityScenarioInput {
  readonly name: string;
  readonly text: string;
}

export interface TaskQualityRequirementInput {
  readonly name: string;
  readonly text: string;
  readonly scenarios: readonly TaskQualityScenarioInput[];
}

export interface TaskQualityInput {
  /** At most 2,000 bytes from the start of the proposal. */
  readonly summary: string;
  /** Every requirement and scenario name, with excerpted text. */
  readonly requirements: readonly TaskQualityRequirementInput[];
  /** In document order; at most 40. */
  readonly tasks: readonly TaskQualityTaskInput[];
}

/** The state sent for the call: exactly the summary excerpt, the requirements, and the tasks. */
export function taskQualityState(input: TaskQualityInput): JsonValue {
  return {
    summary: input.summary,
    requirements: input.requirements.map((requirement) => ({
      name: requirement.name,
      text: requirement.text,
      scenarios: requirement.scenarios.map(({ name, text }) => ({ name, text })),
    })),
    tasks: input.tasks.map((task, position) => ({
      index: position + 1,
      id: task.id,
      description: task.description,
      dependsOn: [...task.dependsOn],
      scopes: { reads: [...task.reads], writes: [...task.writes] },
      verify: [...task.verify],
    })),
  };
}

export interface TaskQualityFinding {
  readonly kind: TaskQualityKind;
  /** One-based, matching the task's index in the state; null for the whole-list coverage finding. */
  readonly index: number | null;
  /** The probability that the defect is present; for size, the confidence of the rubric answer. */
  readonly probability: number;
  /** The rubric score, for a size finding only. */
  readonly score?: number;
}

export interface TaskQualityGateValue {
  readonly findings: readonly TaskQualityFinding[];
}

/** Rounded so a threshold comparison and a rendered probability never show float noise. */
const complement = (value: number): number => Math.round((1 - value) * 1e6) / 1e6;

const GOOD_ANSWER_YES: ReadonlySet<TaskQualityKind> = new Set(["verification", "scope", "atomicity", "coverage"]);

function taskQualityConcern(kind: TaskQualityKind, value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (GOOD_ANSWER_YES.has(kind)) return value < TASK_QUALITY_BANDS.no ? complement(value) : null;
  return value > TASK_QUALITY_BANDS.yes ? value : null;
}

/** Every finding the answers support: per task in task order, then coverage. */
export function taskQualityFindings(answers: JudgmentAnswers): TaskQualityFinding[] {
  const found: TaskQualityFinding[] = [];
  for (const id of Object.keys(answers)) {
    const parsed = parseTaskQualityQuestionId(id);
    if (!parsed) continue;
    if (parsed.kind === "size") {
      const size = scoreOf(answers, id);
      if (
        size && Number.isFinite(size.score) && Number.isFinite(size.confidence)
        && size.score >= TASK_QUALITY_SIZE_AT && size.confidence >= TASK_QUALITY_SIZE_CONFIDENCE
      ) {
        found.push({ kind: "size", index: parsed.index, probability: size.confidence, score: size.score });
      }
      continue;
    }
    const concern = taskQualityConcern(parsed.kind, noulOf(answers, id));
    if (concern !== null) found.push({ kind: parsed.kind, index: parsed.index, probability: concern });
  }
  found.sort((left, right) =>
    left.index! - right.index! || TASK_QUALITY_KINDS.indexOf(left.kind) - TASK_QUALITY_KINDS.indexOf(right.kind));
  const coverage = taskQualityConcern("coverage", noulOf(answers, TASK_QUALITY_COVERAGE_QUESTION_ID));
  if (coverage !== null) found.push({ kind: "coverage", index: null, probability: coverage });
  return found;
}

/** The only text a finding ever has: one fixed sentence per kind, filled with identifiers and numbers. */
const TASK_QUALITY_TEMPLATES: Record<
  TaskQualityKind,
  (fill: { readonly task: string; readonly probability: string; readonly score: string }) => string
> = {
  verification: ({ task, probability }) =>
    `Task ${task}: its verification commands may pass even if the task were implemented incorrectly (probability ${probability}).`,
  scope: ({ task, probability }) =>
    `Task ${task}: its write scopes may not cover every file its description requires changing (probability ${probability}).`,
  atomicity: ({ task, probability }) =>
    `Task ${task}: it may bundle more than one coherent unit of work (probability ${probability}).`,
  dependencies: ({ task, probability }) =>
    `Task ${task}: it may depend on work that is not among its listed dependencies (probability ${probability}).`,
  size: ({ task, probability, score }) =>
    `Task ${task}: it may be too large to verify as one unit (size ${score} of 3, probability ${probability}).`,
  coverage: ({ probability }) =>
    `The tasks together may not cover every requirement (probability ${probability}).`,
};

/** Renders one finding, or null when its task index names no task in `taskIds`. */
export function renderTaskQualityFinding(finding: TaskQualityFinding, taskIds: readonly string[]): string | null {
  const task = finding.index === null ? "" : taskIds[finding.index - 1];
  if (task === undefined) return null;
  return TASK_QUALITY_TEMPLATES[finding.kind]({
    task,
    probability: finding.probability.toFixed(2),
    score: (finding.score ?? 0).toFixed(1),
  });
}

/** Rendered findings, highest probability first and capped, with the total that were produced. */
export function presentTaskQualityFindings(
  findings: readonly TaskQualityFinding[],
  taskIds: readonly string[],
  limit: number = TASK_QUALITY_MAX_DISPLAYED,
): { readonly total: number; readonly lines: readonly string[] } {
  const rendered = findings
    .map((finding) => ({ finding, text: renderTaskQualityFinding(finding, taskIds) }))
    .filter((entry): entry is { finding: TaskQualityFinding; text: string } => entry.text !== null)
    .sort((left, right) => right.finding.probability - left.finding.probability);
  return { total: rendered.length, lines: rendered.slice(0, limit).map((entry) => entry.text) };
}

export const planningTaskQualityDecision = defineDecision<TaskQualityInput, TaskQualityGateValue>({
  id: "planning.task_quality",
  version: 1,
  // Findings are advice; they grant nothing and skip nothing.
  effects: ["adds_advice"],
  representativeInput: {
    summary: "Retry invoice parsing when the total is missing.",
    requirements: [{
      name: "A missing invoice total is retried once",
      text: "The parser SHALL retry once when invoice_total is missing.",
      scenarios: [{ name: "Missing total is retried", text: "WHEN the total is missing THEN one retry is made" }],
    }],
    tasks: [
      {
        id: "1.1",
        description: "Retry `parseInvoice` once when invoice_total is missing",
        dependsOn: [],
        reads: ["src/billing/**"],
        writes: ["src/billing/invoice.ts", "tests/billing/invoice.test.ts"],
        verify: ["bun test tests/billing/invoice.test.ts"],
      },
      {
        id: "1.2",
        description: "Document the retry in the billing guide",
        dependsOn: ["1.1"],
        reads: [],
        writes: ["docs/billing.md"],
        verify: ["bun run docs:check"],
      },
    ],
  },
  questions: (input) => taskQualityQuestions(input.tasks.length),
  gate: (answers) => {
    const findings = taskQualityFindings(answers);
    return findings.length > 0 ? act({ findings }) : abstain("no check crossed its threshold");
  },
});

/**
 * debugging.thrash: whether a repair loop's latest two failures are getting anywhere. A round
 * is stalled when the failures share a root cause and the attempted fix made no progress; two
 * consecutive stalled rounds cut the loop short, and a failure that needs a human stops it.
 * These bands only ever shorten a loop; they are starting points, and the calibration data the
 * ungated answers build will show whether they should move.
 */
export const THRASH_SAME_CAUSE_ABOVE = 0.8;
export const THRASH_NO_PROGRESS_BELOW = 0.3;
export const THRASH_HUMAN_NEEDED_ABOVE = 0.8;
/** Consecutive stalled rounds, each at its own attempt, that move a task to systematic debugging. */
export const THRASH_STALLED_ROUNDS = 2;

export interface ThrashFailureInput {
  readonly attempt: number;
  readonly reproduction: string;
  readonly evidence: readonly string[];
}

export interface ThrashInput {
  /** The task's definition: what it was asked to do. */
  readonly taskDefinition: string;
  readonly previous: ThrashFailureInput;
  readonly latest: ThrashFailureInput & {
    /** What the builder changed in the attempt that produced the latest failure. */
    readonly attemptedFix: string;
  };
}

export function thrashState(input: ThrashInput): JsonValue {
  return {
    task: input.taskDefinition,
    previousFailure: {
      attempt: input.previous.attempt,
      reproduction: input.previous.reproduction,
      evidence: [...input.previous.evidence],
    },
    latestFailure: {
      attempt: input.latest.attempt,
      reproduction: input.latest.reproduction,
      evidence: [...input.latest.evidence],
      attemptedFix: input.latest.attemptedFix,
    },
  };
}

/**
 * The gated readings. The gate reports what the answers say and nothing more: whether two
 * rounds in a row stalled is a fact about history, which a gate cannot see, so the path is
 * decided by the caller from the state. It abstains only when a gated answer is missing.
 */
export interface ThrashGateValue {
  readonly sameRootCause: number;
  readonly progress: number;
  readonly humanNeeded: number;
}

export const debuggingThrashDecision = defineDecision<ThrashInput, ThrashGateValue>({
  id: "debugging.thrash",
  version: 1,
  // Escalating early cuts attempts; stopping for a human is caution. Neither grants anything,
  // and both only ever shorten a loop.
  effects: ["reduces_work", "adds_caution"],
  representativeInput: {
    taskDefinition: "Retry `parseInvoice` once when invoice_total is missing",
    previous: { attempt: 1, reproduction: "bun test tests/billing/invoice.test.ts", evidence: ["Expected 1 retry, received 0"] },
    latest: {
      attempt: 2,
      reproduction: "bun test tests/billing/invoice.test.ts",
      evidence: ["Expected 1 retry, received 0"],
      attemptedFix: "Moved the retry above the total check",
    },
  },
  questions: () => thrashQuestions,
  gate: (answers) => {
    const sameRootCause = noulOf(answers, THRASH_QUESTION_IDS.sameRootCause);
    const progress = noulOf(answers, THRASH_QUESTION_IDS.progress);
    const humanNeeded = noulOf(answers, THRASH_QUESTION_IDS.humanNeeded);
    if (sameRootCause === null || progress === null || humanNeeded === null) {
      return abstain("a gated answer is missing");
    }
    return act({ sameRootCause, progress, humanNeeded });
  },
});

/**
 * review.triage: whether an approved planning review may be carried across an edit that only
 * touched the proposal or the design. This is the one decision in which a model's answer can
 * decide whether a correctness gate runs, so it acts only on a conjunction: the edit is judged
 * immaterial with high confidence, and every question about what it changed is confidently no.
 * Anything else, including a missing or malformed answer, abstains into a full review. These
 * bounds are starting points; the shadow-mode false-skip report is what tunes them.
 */
export const REVIEW_TRIAGE_ENABLE_VARIABLE = "MUSTER_JEV_REVIEW_TRIAGE";
/** The materiality score must be strictly below this: wording only, or a clarification. */
export const REVIEW_TRIAGE_MATERIALITY_BELOW = 1.5;
/** The materiality answer must be at least this confident. */
export const REVIEW_TRIAGE_CONFIDENCE_AT_LEAST = 0.85;
/** Every yes/no probability must be strictly below this. */
export const REVIEW_TRIAGE_CHANGE_BELOW = 0.25;

/** A file's diff, as sent; empty when the file did not change. */
export interface ReviewTriageInput {
  readonly proposalDiff: string;
  readonly designDiff: string;
  /** The recommendations of the review that approved. */
  readonly recommendations: readonly string[];
}

/** The state sent for the call: exactly the two diffs and the approving review's recommendations. */
export function reviewTriageState(input: ReviewTriageInput): JsonValue {
  return {
    proposalDiff: input.proposalDiff,
    designDiff: input.designDiff,
    previousRecommendations: [...input.recommendations],
  };
}

export interface ReviewTriageGateValue {
  readonly materiality: number;
  readonly materialityConfidence: number;
  /** Each yes/no question's probability, in question order. */
  readonly changes: Readonly<Record<string, number>>;
}

export const reviewTriageDecision = defineDecision<ReviewTriageInput, ReviewTriageGateValue>({
  id: "review.triage",
  version: 1,
  // Acting skips a full planning review, so every abstention falls through to that review.
  effects: ["reduces_work"],
  enabledBy: REVIEW_TRIAGE_ENABLE_VARIABLE,
  representativeInput: {
    proposalDiff: "@@ -3 +3 @@\n-Add serch to the command palette.\n+Add search to the command palette.\n",
    designDiff: "",
    recommendations: ["Keep the palette entry point in one module."],
  },
  questions: () => reviewTriageQuestions,
  gate: (answers) => {
    const materiality = scoreOf(answers, REVIEW_TRIAGE_QUESTION_IDS.materiality);
    if (!materiality || !Number.isFinite(materiality.score) || !Number.isFinite(materiality.confidence)) {
      return abstain("no materiality was judged");
    }
    if (materiality.confidence < REVIEW_TRIAGE_CONFIDENCE_AT_LEAST) {
      return abstain(`materiality confidence ${materiality.confidence} is below ${REVIEW_TRIAGE_CONFIDENCE_AT_LEAST}`);
    }
    if (!(materiality.score < REVIEW_TRIAGE_MATERIALITY_BELOW)) {
      return abstain(`materiality ${materiality.score} is not below ${REVIEW_TRIAGE_MATERIALITY_BELOW}`);
    }
    const changes: Record<string, number> = {};
    for (const id of REVIEW_TRIAGE_CHANGE_QUESTION_IDS) {
      const probability = noulOf(answers, id);
      if (probability === null || !Number.isFinite(probability)) return abstain(`${id} was not answered`);
      if (!(probability < REVIEW_TRIAGE_CHANGE_BELOW)) {
        return abstain(`${id} probability ${probability} is not below ${REVIEW_TRIAGE_CHANGE_BELOW}`);
      }
      changes[id] = probability;
    }
    return act({
      materiality: materiality.score,
      materialityConfidence: materiality.confidence,
      changes,
    });
  },
});

/**
 * routing.task_model: whether a builder task may run on the economy lane instead of the primary
 * builder. Acting downgrades the model, the one change in the rollout that can lower output
 * quality, so it acts only on a conjunction of guards: the task is confidently mechanical, each
 * of five risks is confidently absent, and its reach is confidently narrow. Every guard needs a
 * confident answer, so a missing, malformed, or uncertain one abstains into the primary builder.
 * These bounds are starting points; the per-lane first-attempt success report is what tunes them.
 */
export const TASK_ROUTING_ENABLE_VARIABLE = "MUSTER_JEV_MODEL_ROUTING";
/** The mechanical probability must be strictly above this. */
export const TASK_ROUTING_MECHANICAL_ABOVE = 0.8;
/** Every risk probability must be strictly below this. */
export const TASK_ROUTING_RISK_BELOW = 0.3;
/** The reach score must be strictly below this: contained or neighbouring. */
export const TASK_ROUTING_REACH_BELOW = 1.5;
/** The reach answer must be at least this confident. */
export const TASK_ROUTING_REACH_CONFIDENCE = 0.8;

export type TaskRoutingLane = "primary" | "economy";

/** A task's contract, as sent: no source and no file content. */
export interface TaskRoutingInput {
  readonly description: string;
  readonly requirements: readonly string[];
  readonly scenarios: readonly string[];
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly verify: readonly string[];
}

/** The state sent for the call: exactly the task's description, requirements, scenarios, scopes, and verification. */
export function taskRoutingState(input: TaskRoutingInput): JsonValue {
  return {
    description: input.description,
    requirements: [...input.requirements],
    scenarios: [...input.scenarios],
    reads: [...input.reads],
    writes: [...input.writes],
    verify: [...input.verify],
  };
}

export interface TaskRoutingGateValue {
  /** The lane the gate chose; the gate acts only to choose the economy lane. */
  readonly lane: "economy";
  readonly mechanical: number;
  /** Each risk question's probability, in question order. */
  readonly risks: Readonly<Record<string, number>>;
  readonly reach: number;
  readonly reachConfidence: number;
}

export const modelRoutingDecision = defineDecision<TaskRoutingInput, TaskRoutingGateValue>({
  id: "routing.task_model",
  version: 1,
  // Acting spends less on the same work; every abstention falls through to the primary builder.
  effects: ["reduces_work"],
  enabledBy: TASK_ROUTING_ENABLE_VARIABLE,
  representativeInput: {
    description: "Rename the `--verbose` flag to `--debug` in the command parser and its help text",
    requirements: ["cli: The debug flag is accepted"],
    scenarios: ["Debug flag enables debug output"],
    reads: ["src/cli/**"],
    writes: ["src/cli/parser.ts", "tests/cli/parser.test.ts"],
    verify: ["bun test tests/cli/parser.test.ts"],
  },
  questions: () => taskRoutingQuestions,
  gate: (answers) => {
    const failed: string[] = [];
    const mechanical = noulOf(answers, TASK_ROUTING_QUESTION_IDS.mechanical);
    if (mechanical === null || !Number.isFinite(mechanical)) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.mechanical} was not answered`);
    } else if (!(mechanical > TASK_ROUTING_MECHANICAL_ABOVE)) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.mechanical} probability ${mechanical} is not above ${TASK_ROUTING_MECHANICAL_ABOVE}`);
    }
    const risks: Record<string, number> = {};
    for (const id of TASK_ROUTING_RISK_QUESTION_IDS) {
      const probability = noulOf(answers, id);
      if (probability === null || !Number.isFinite(probability)) {
        failed.push(`${id} was not answered`);
      } else if (!(probability < TASK_ROUTING_RISK_BELOW)) {
        failed.push(`${id} probability ${probability} is not below ${TASK_ROUTING_RISK_BELOW}`);
      } else {
        risks[id] = probability;
      }
    }
    const reach = scoreOf(answers, TASK_ROUTING_QUESTION_IDS.reach);
    if (!reach || !Number.isFinite(reach.score) || !Number.isFinite(reach.confidence)) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.reach} was not answered`);
    } else if (reach.confidence < TASK_ROUTING_REACH_CONFIDENCE) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.reach} confidence ${reach.confidence} is below ${TASK_ROUTING_REACH_CONFIDENCE}`);
    } else if (!(reach.score < TASK_ROUTING_REACH_BELOW)) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.reach} ${reach.score} is not below ${TASK_ROUTING_REACH_BELOW}`);
    }
    if (failed.length > 0 || mechanical === null || !reach) return abstain(failed.join("; "));
    return act({
      lane: "economy" as const,
      mechanical,
      risks,
      reach: reach.score,
      reachConfidence: reach.confidence,
    });
  },
});

/**
 * Every decision the harness can ask. Later changes append here; none modifies another's.
 */
export const judgmentCatalog: readonly AnyDecision[] = [
  planningComplexityDecision,
  planningPreflightDecision,
  contextCapsuleRankingDecision,
  reviewTaskFocusDecision,
  commandClassificationDecision,
  reviewExtractionDecision,
  planningTaskQualityDecision,
  debuggingThrashDecision,
  reviewTriageDecision,
  modelRoutingDecision,
];
