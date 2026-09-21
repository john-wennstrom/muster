import type { JsonValue, JudgmentAnswers } from "../client.ts";
import { act, abstain, defineDecision, noulOf, scoreOf } from "../decision.ts";
import { TASK_FOCUS_QUESTION_IDS } from "../questions.ts";
import { loadQuestions } from "../../prompts/questions.ts";

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
 *
 * The same answers also decide whether a review may be skipped: only when every question is
 * answered confidently with its good value, so no item speaks and none is uncertain. The gate
 * only reports that; the guards outside the answers (mode, lane, evidence, scope) are the
 * caller's, because a gate sees answers and nothing else.
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
  /** Whether the answer is confidently the good one, which a skipped review needs of every question. */
  readonly confidentlyGood: (answers: JudgmentAnswers) => boolean;
}

/** A question a good change answers yes to: it speaks on a confident no, and is good on a confident yes. */
const goodWhenTrue = (id: string) => ({
  speaks: (answers: JudgmentAnswers): boolean => {
    const value = noulOf(answers, id);
    return value !== null && value < TASK_FOCUS_BANDS.no;
  },
  confidentlyGood: (answers: JudgmentAnswers): boolean => {
    const value = noulOf(answers, id);
    return value !== null && Number.isFinite(value) && value >= TASK_FOCUS_BANDS.yes;
  },
});

/** A question a good change answers no to: it speaks on a confident yes, and is good on a confident no. */
const goodWhenFalse = (id: string) => ({
  speaks: (answers: JudgmentAnswers): boolean => {
    const value = noulOf(answers, id);
    return value !== null && value > TASK_FOCUS_BANDS.yes;
  },
  confidentlyGood: (answers: JudgmentAnswers): boolean => {
    const value = noulOf(answers, id);
    return value !== null && Number.isFinite(value) && value <= TASK_FOCUS_BANDS.no;
  },
});

/** In priority order: most consequential first. */
export const TASK_FOCUS_CATALOGUE: readonly TaskFocusEntry[] = [
  {
    id: TASK_FOCUS_QUESTION_IDS.securityBoundary,
    phrase: "Whether the diff changes what is allowed or trusted: permissions, credentials, or validation of untrusted input",
    area: "diff",
    ...goodWhenFalse(TASK_FOCUS_QUESTION_IDS.securityBoundary),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.scopeContainment,
    phrase: "Whether every changed file is inside the authorized write scopes",
    area: "scopes",
    ...goodWhenTrue(TASK_FOCUS_QUESTION_IDS.scopeContainment),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.contractMatch,
    phrase: "Whether the diff implements what the task contract's requirements describe",
    area: "contract",
    ...goodWhenTrue(TASK_FOCUS_QUESTION_IDS.contractMatch),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.scenarioCoverage,
    phrase: "Whether the tests exercise each of the task's scenarios",
    area: "tests",
    ...goodWhenTrue(TASK_FOCUS_QUESTION_IDS.scenarioCoverage),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.testFirstConsistency,
    phrase: "Whether the test-first evidence is consistent with the diff",
    area: "tdd",
    ...goodWhenTrue(TASK_FOCUS_QUESTION_IDS.testFirstConsistency),
  },
  {
    id: TASK_FOCUS_QUESTION_IDS.stubOrHardcoded,
    phrase: "Whether the diff adds a stub, placeholder, or hard-coded value in place of real behavior",
    area: "diff",
    ...goodWhenFalse(TASK_FOCUS_QUESTION_IDS.stubOrHardcoded),
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
    confidentlyGood: (answers) => {
      const value = scoreOf(answers, TASK_FOCUS_QUESTION_IDS.reach);
      return value !== null
        && Number.isFinite(value.score)
        && value.score < TASK_FOCUS_REACH_AT
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
  /** True only when every question was answered confidently with its good value. */
  readonly skip: boolean;
}

export const reviewTaskFocusDecision = defineDecision<TaskFocusInput, TaskFocusGateValue>({
  id: "review.task_focus",
  version: 2,
  // The focus list is advice to a reviewer that still runs and decides; a skip saves the review.
  effects: ["adds_advice", "reduces_work"],
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
  questions: () => loadQuestions("review.task_focus"),
  state: taskFocusState,
  gate: (answers) => {
    const items = TASK_FOCUS_CATALOGUE
      .filter((entry) => entry.speaks(answers))
      .slice(0, TASK_FOCUS_MAX_ITEMS)
      .map(({ id, phrase, area }): TaskFocusItem => ({ id, phrase, area }));
    const skip = TASK_FOCUS_CATALOGUE.every((entry) => entry.confidentlyGood(answers));
    return items.length > 0 || skip ? act({ items, skip }) : abstain("no check crossed its threshold");
  },
});
