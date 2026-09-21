import { describe, expect, test } from "bun:test";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { REVIEW_EXTRACTION_CONFIDENCE_FLOOR, reviewExtractionDecision, reviewExtractionState, type ReviewExtractionGateValue } from "../../src/judgment/decisions/review-extraction.ts";
import { judgmentCatalog, validateCatalog } from "../../src/judgment/catalog.ts";
import { validateDecision } from "../../src/judgment/decision.ts";
import {
  REVIEW_EXTRACTION_LINE_KINDS,
  REVIEW_EXTRACTION_QUESTION_IDS,
  REVIEW_EXTRACTION_VERDICTS,
  parseReviewExtractionLineQuestionId,
  reviewExtractionLineQuestionId,
  } from "../../src/judgment/questions.ts";
import { planningReviewSubmissionSchema } from "../../src/review/review-artifact.ts";
import {
  assembleReviewSubmission,
  parseReviewCandidates,
  type ReviewCandidate
} from "../../src/review/review-extraction.ts";
import { loadQuestions } from "../../src/prompts/questions.ts";

const reviewExtractionQuestions = (count: number) => loadQuestions("review.extraction", { candidates: Array.from({ length: count }, () => ({})) });

type Kind = (typeof REVIEW_EXTRACTION_LINE_KINDS)[number];
type Verdict = (typeof REVIEW_EXTRACTION_VERDICTS)[number];

const verdict = (choice: Verdict | string, confidence = 0.9): JudgmentAnswers => ({
  [REVIEW_EXTRACTION_QUESTION_IDS.verdict]: {
    type: "choice",
    choice,
    probabilities: { [choice]: confidence },
    confidence,
  }
});

/** A verdict, then one line answer per entry, each with its own confidence. */
function answersFor(
  overall: Verdict | string,
  lines: ReadonlyArray<Kind | string | readonly [Kind | string, number]>,
  overallConfidence = 0.9,
): JudgmentAnswers {
  const answers: Record<string, JudgmentAnswers[string]> = { ...verdict(overall, overallConfidence) };
  lines.forEach((line, position) => {
    const [kind, confidence] = typeof line === "string" ? [line, 0.9] : line;
    answers[reviewExtractionLineQuestionId(position + 1)] = {
      type: "choice",
      choice: kind,
      probabilities: { [kind]: confidence },
      confidence,
    };
  });
  return answers;
}

const response = [
  "I read all four artifacts.",
  "",
  "## Required changes",
  "- The migration step has no rollback.",
  "",
  "## Recommendations",
  "- Consider a shorter task list.",
].join("\n");

const candidates = (() => {
  const parsed = parseReviewCandidates(response);
  if (parsed.skipped) throw new Error("fixture response skipped");
  return parsed.candidates;
})();

const gate = (answers: JudgmentAnswers) => reviewExtractionDecision.gate(answers);

function accepted(answers: JudgmentAnswers): ReviewExtractionGateValue {
  const outcome = gate(answers);
  if (!outcome.act) throw new Error(`expected acceptance, abstained: ${outcome.reason}`);
  return outcome.value;
}

describe("review.extraction registration", () => {
  test("declares that it only reduces work", () => {
    expect(reviewExtractionDecision.id).toBe("review.extraction");
    expect(reviewExtractionDecision.effects).toEqual(["reduces_work"]);
  });

  test("is registered in the catalog, which still validates", () => {
    expect(judgmentCatalog).toContain(reviewExtractionDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
    expect(() => validateDecision(reviewExtractionDecision)).not.toThrow();
  });

  test("asks one verdict choice and one kind choice per candidate", () => {
    const entries = reviewExtractionQuestions(3);

    expect(entries.map(([id]) => id)).toEqual(["verdict", "line_1_kind", "line_2_kind", "line_3_kind"]);
    for (const [, question] of entries) expect(question.type).toBe("choice");
    const [, verdictQuestion] = entries[0]!;
    expect(verdictQuestion.type === "choice" && Object.keys(verdictQuestion.criteria)).toEqual([
      ...REVIEW_EXTRACTION_VERDICTS,
    ]);
    const [, lineQuestion] = entries[1]!;
    expect(lineQuestion.type === "choice" && Object.keys(lineQuestion.criteria)).toEqual([
      ...REVIEW_EXTRACTION_LINE_KINDS,
    ]);
  });

  test("line question identifiers round trip and reject other identifiers", () => {
    expect(parseReviewExtractionLineQuestionId(reviewExtractionLineQuestionId(12))).toBe(12);
    for (const id of ["verdict", "line_kind", "line_1", "candidate_1_kind"]) {
      expect(parseReviewExtractionLineQuestionId(id)).toBeNull();
    }
  });

  test("the state holds exactly the response and its candidate lines", () => {
    const state = reviewExtractionState({ response, candidates }) as {
      response: string;
      candidates: Array<Record<string, unknown>>;
    };

    expect(Object.keys(state).sort()).toEqual(["candidates", "response"]);
    expect(state.response).toBe(response);
    expect(state.candidates).toEqual([
      { index: 1, heading: null, text: "I read all four artifacts." },
      { index: 2, heading: "Required changes", text: "The migration step has no rollback." },
      { index: 3, heading: "Recommendations", text: "Consider a shorter task list." },
    ]);
  });
});

describe("review.extraction gate", () => {
  test("accepts a confident revise with a blocking line", () => {
    const value = accepted(answersFor("revise", ["not_a_finding", "required", "recommendation"]));

    expect(value.verdict).toBe("revise");
    expect(value.lines.map(({ index, kind }) => [index, kind])).toEqual([
      [1, "not_a_finding"],
      [2, "required"],
      [3, "recommendation"],
    ]);
  });

  test("accepts a confident approve with only recommendations and narration", () => {
    const value = accepted(answersFor("approve", ["not_a_finding", "recommendation", "recommendation"]));

    expect(value.verdict).toBe("approve");
  });

  test("accepts a critical line as blocking", () => {
    expect(accepted(answersFor("revise", ["critical", "not_a_finding", "not_a_finding"])).verdict).toBe("revise");
  });

  test("accepts at exactly the confidence floor", () => {
    expect(REVIEW_EXTRACTION_CONFIDENCE_FLOOR).toBe(0.8);
    expect(gate(answersFor("revise", [["required", 0.8]], 0.8)).act).toBeTrue();
  });

  test("abstains when any line is below the floor", () => {
    const outcome = gate(answersFor("revise", ["not_a_finding", ["required", 0.79], "recommendation"]));

    expect(outcome).toEqual({ act: false, reason: expect.stringContaining("line 2") });
  });

  test("abstains when the verdict is below the floor", () => {
    expect(gate(answersFor("revise", ["required"], 0.79)).act).toBeFalse();
    expect(gate(answersFor("approve", ["recommendation"], 0.5)).act).toBeFalse();
  });

  test("abstains on an unclear verdict at any confidence", () => {
    expect(gate(answersFor("unclear", ["not_a_finding", "recommendation"], 0.99)).act).toBeFalse();
  });

  test("abstains on an approval with a critical or required line", () => {
    for (const blocking of ["critical", "required"]) {
      const outcome = gate(answersFor("approve", ["not_a_finding", blocking, "recommendation"]));
      expect(outcome).toEqual({ act: false, reason: "approve with a critical or required line" });
    }
  });

  test("abstains on a revise with no critical or required line", () => {
    const outcome = gate(answersFor("revise", ["not_a_finding", "recommendation", "recommendation"]));

    expect(outcome).toEqual({ act: false, reason: "revise with no critical or required line" });
  });

  test("abstains when the verdict or a line kind is not one it knows", () => {
    expect(gate(answersFor("maybe", ["required"])).act).toBeFalse();
    expect(gate(answersFor("revise", ["required", "blocker"])).act).toBeFalse();
  });

  test("abstains when there is no verdict, no lines, or a mistyped answer", () => {
    expect(gate({}).act).toBeFalse();
    expect(gate(verdict("revise")).act).toBeFalse();
    expect(gate({
      ...verdict("revise"),
      [reviewExtractionLineQuestionId(1)]: { type: "noul", noul: 0.9 },
    }).act).toBeFalse();
    expect(gate({
      ...answersFor("revise", ["required"]),
      [REVIEW_EXTRACTION_QUESTION_IDS.verdict]: { type: "noul", noul: 0.9 },
    }).act).toBeFalse();
  });

  test("returns lines in line order regardless of answer order", () => {
    const shuffled: JudgmentAnswers = {
      ...verdict("revise"),
      ...Object.fromEntries(Object.entries(answersFor("revise", ["recommendation", "required", "not_a_finding"])).reverse()),
    };

    expect(accepted(shuffled).lines.map(({ index }) => index)).toEqual([1, 2, 3]);
  });
});

describe("review extraction assembly", () => {
  const value = (answers: JudgmentAnswers) => accepted(answers);

  test("assembles the review from verbatim candidate lines", () => {
    const assembled = assembleReviewSubmission(
      candidates,
      value(answersFor("revise", ["not_a_finding", "required", "recommendation"])),
    );

    expect(assembled).toEqual({
      ok: true,
      submission: {
        verdict: "REVISE",
        criticalFindings: [],
        requiredChanges: ["The migration step has no rollback."],
        recommendations: ["Consider a shorter task list."],
      },
    });
  });

  test("routes each kind to its own list and leaves narration out", () => {
    const four: ReviewCandidate[] = ["a", "b", "c", "d"].map((text, position) => ({
      index: position + 1,
      heading: null,
      text: `line ${text}`,
    }));
    const assembled = assembleReviewSubmission(
      four,
      value(answersFor("revise", ["critical", "required", "recommendation", "not_a_finding"])),
    );

    expect(assembled).toEqual({
      ok: true,
      submission: {
        verdict: "REVISE",
        criticalFindings: ["line a"],
        requiredChanges: ["line b"],
        recommendations: ["line c"],
      },
    });
  });

  test("an approval assembles with an empty blocking list", () => {
    const assembled = assembleReviewSubmission(
      candidates,
      value(answersFor("approve", ["not_a_finding", "not_a_finding", "recommendation"])),
    );

    expect(assembled.ok && assembled.submission).toEqual({
      verdict: "APPROVE",
      criticalFindings: [],
      requiredChanges: [],
      recommendations: ["Consider a shorter task list."],
    });
  });

  test("every assembled submission passes the existing submission schema", () => {
    const table: Array<[Verdict, Kind[]]> = [
      ["revise", ["not_a_finding", "required", "recommendation"]],
      ["revise", ["critical", "critical", "critical"]],
      ["approve", ["recommendation", "recommendation", "recommendation"]],
      ["approve", ["not_a_finding", "not_a_finding", "not_a_finding"]],
    ];
    for (const [overall, kinds] of table) {
      const assembled = assembleReviewSubmission(candidates, value(answersFor(overall, kinds)));
      expect(assembled.ok).toBeTrue();
      if (assembled.ok) expect(planningReviewSubmissionSchema.safeParse(assembled.submission).success).toBeTrue();
    }
  });

  test("every assembled finding is a candidate line", () => {
    const assembled = assembleReviewSubmission(candidates, value(answersFor("revise", ["critical", "required", "recommendation"])));
    const lines = new Set(candidates.map(({ text }) => text));

    expect(assembled.ok).toBeTrue();
    if (!assembled.ok) return;
    for (const finding of [
      ...assembled.submission.criticalFindings,
      ...assembled.submission.requiredChanges,
      ...assembled.submission.recommendations,
    ]) expect(lines.has(finding)).toBeTrue();
  });

  test("declines when a candidate has no classification", () => {
    const partial = value(answersFor("revise", ["required", "recommendation"]));

    const assembled = assembleReviewSubmission(candidates, partial);
    expect(assembled).toEqual({ ok: false, reason: "line 3 was not classified" });
  });

  test("declines when a classification names no candidate", () => {
    const extra = value(answersFor("revise", ["required", "recommendation", "recommendation", "recommendation"]));

    expect(assembleReviewSubmission(candidates, extra).ok).toBeFalse();
  });

  test("declines a line classified twice", () => {
    const doubled: ReviewExtractionGateValue = {
      verdict: "revise",
      verdictConfidence: 0.9,
      lines: [
        { index: 1, kind: "required", confidence: 0.9 },
        { index: 1, kind: "recommendation", confidence: 0.9 },
        { index: 3, kind: "recommendation", confidence: 0.9 },
      ],
    };

    expect(assembleReviewSubmission(candidates, doubled).ok).toBeFalse();
  });

  test("declines an inconsistent value even though the gate never produces one", () => {
    const inconsistent: ReviewExtractionGateValue = {
      verdict: "approve",
      verdictConfidence: 0.9,
      lines: [
        { index: 1, kind: "not_a_finding", confidence: 0.9 },
        { index: 2, kind: "required", confidence: 0.9 },
        { index: 3, kind: "recommendation", confidence: 0.9 },
      ],
    };

    const assembled = assembleReviewSubmission(candidates, inconsistent);
    expect(assembled.ok).toBeFalse();
  });
});
