import type { JsonValue } from "../client.ts";
import { act, abstain, defineDecision, choiceOf } from "../decision.ts";
import { REVIEW_EXTRACTION_LINE_KINDS, REVIEW_EXTRACTION_QUESTION_IDS, REVIEW_EXTRACTION_VERDICTS, parseReviewExtractionLineQuestionId, type ReviewExtractionLineKind } from "../questions.ts";
import { loadQuestions } from "../../prompts/questions.ts";

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
  questions: (input) => loadQuestions("review.extraction", { candidates: input.candidates }),
  state: reviewExtractionState,
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
