import type { JsonValue } from "../client.ts";
import { act, abstain, defineDecision, noulOf, scoreOf } from "../decision.ts";
import { REVIEW_TRIAGE_CHANGE_QUESTION_IDS, REVIEW_TRIAGE_QUESTION_IDS } from "../questions.ts";
import { loadQuestions } from "../../prompts/questions.ts";

/**
 * review.triage: whether an approved planning review may be carried across an edit that only
 * touched the proposal or the design. This is the one decision in which a model's answer can
 * decide whether a correctness gate runs, so it acts only on a conjunction: the edit is judged
 * immaterial with high confidence, and every question about what it changed is confidently no.
 * Anything else, including a missing or malformed answer, abstains into a full review. These
 * bounds are starting points; the outcomes recorded in shadow mode are what tune them.
 */
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
  representativeInput: {
    proposalDiff: "@@ -3 +3 @@\n-Add serch to the command palette.\n+Add search to the command palette.\n",
    designDiff: "",
    recommendations: ["Keep the palette entry point in one module."],
  },
  questions: () => loadQuestions("review.triage"),
  state: reviewTriageState,
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
