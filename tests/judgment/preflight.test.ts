import { describe, expect, test } from "bun:test";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import {
  decisionFingerprint,
  judgmentCatalog,
  planningPreflightDecision,
  preflightCandidateAnswers,
  preflightState,
  PREFLIGHT_CONFIDENCE_FLOOR,
  PREFLIGHT_CORROBORATION_FLOOR,
  validateCatalog,
  validateDecision,
} from "../../src/judgment/gates.ts";
import {
  PREFLIGHT_QUESTION_IDS as Q,
  parsePreflightCandidateQuestionId,
  preflightCandidateQuestionId,
  preflightQuestions,
} from "../../src/judgment/questions.ts";

const gate = planningPreflightDecision.gate;

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const disposition = (choice: string, confidence: number) => ({
  type: "choice" as const,
  choice,
  probabilities: { [choice]: confidence },
  confidence,
});
const ambiguity = { type: "score" as const, score: 0, probabilities: { "0": 1 }, confidence: 0.9 };

/** A candidate's two answers, as [implements, needsChange] per candidate in order. */
function answers(
  choice: string,
  confidence: number,
  candidates: readonly (readonly [number, number])[] = [],
): JudgmentAnswers {
  return {
    [Q.disposition]: disposition(choice, confidence),
    [Q.ambiguity]: ambiguity,
    ...Object.fromEntries(candidates.flatMap(([implemented, needsChange], position) => [
      [preflightCandidateQuestionId(position + 1, "implements"), noul(implemented)],
      [preflightCandidateQuestionId(position + 1, "needs_change"), noul(needsChange)],
    ])),
  };
}

describe("planning.preflight questions", () => {
  test("asks the disposition, the ambiguity rubric, and two questions per candidate", () => {
    expect(Object.keys(validateDecision(planningPreflightDecision))).toEqual([
      "disposition",
      "ambiguity",
      "candidate_1_implements",
      "candidate_1_needs_change",
      "candidate_2_implements",
      "candidate_2_needs_change",
    ]);
  });

  test("the question count scales with the candidate count", () => {
    for (const count of [0, 1, 4, 10]) {
      expect(preflightQuestions(count)).toHaveLength(2 + 2 * count);
      expect(planningPreflightDecision.questions({ request: "x", candidates: Array.from({ length: count }, () => ({ path: "a", excerpt: "b" })) }))
        .toHaveLength(2 + 2 * count);
    }
  });

  test("the disposition offers exactly the three dispositions the agent path uses", () => {
    const question = Object.fromEntries(preflightQuestions(0))[Q.disposition]!;
    expect(question.type).toBe("choice");
    expect(question.type === "choice" && Object.keys(question.criteria)).toEqual([
      "proceed", "needs_clarification", "already_satisfied",
    ]);
  });

  test("the per-candidate wording asks about implementing, not about mentioning", () => {
    const questions = Object.fromEntries(preflightQuestions(1));
    const implemented = questions[preflightCandidateQuestionId(1, "implements")]!.instructions;
    expect(implemented).toMatch(/already implement what the request asks for/i);
    expect(implemented).toMatch(/only mentions the same names[^.]*answers no/i);
    const needsChange = questions[preflightCandidateQuestionId(1, "needs_change")]!.instructions;
    expect(needsChange).toMatch(/need to be modified/i);
    expect(questions[Q.disposition]!.instructions).toMatch(/only mentions the same names/i);
  });

  test("question identifiers round-trip and reject anything else", () => {
    expect(parsePreflightCandidateQuestionId(preflightCandidateQuestionId(7, "needs_change")))
      .toEqual({ index: 7, kind: "needs_change" });
    expect(parsePreflightCandidateQuestionId("disposition")).toBeNull();
    expect(parsePreflightCandidateQuestionId("candidate_x_implements")).toBeNull();
  });

  test("changing any wording changes the decision's fingerprint", () => {
    expect(decisionFingerprint(planningPreflightDecision)).toBe(decisionFingerprint(planningPreflightDecision));
    const reworded = { ...planningPreflightDecision, questions: () => preflightQuestions(2).slice(1) };
    expect(decisionFingerprint(reworded)).not.toBe(decisionFingerprint(planningPreflightDecision));
  });

  test("is in the catalog, which stays valid", () => {
    expect(judgmentCatalog).toContain(planningPreflightDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
  });

  test("declares that it reduces work", () => {
    expect([...planningPreflightDecision.effects]).toEqual(["reduces_work"]);
  });
});

describe("planning.preflight state", () => {
  test("holds exactly the request and each candidate's index, path, and excerpt", () => {
    expect(preflightState({
      request: "Retry parseInvoice",
      candidates: [{ path: "src/a.ts", excerpt: "1: x" }, { path: "src/b.ts", excerpt: "2: y" }],
    })).toEqual({
      request: "Retry parseInvoice",
      candidates: [
        { index: 1, path: "src/a.ts", excerpt: "1: x" },
        { index: 2, path: "src/b.ts", excerpt: "2: y" },
      ],
    });
  });
});

describe("planning.preflight gate", () => {
  test("acts for a proceed at the confidence floor, with the candidate answers", () => {
    expect(PREFLIGHT_CONFIDENCE_FLOOR).toBe(0.8);
    expect(gate(answers("proceed", 0.8, [[0.1, 0.9], [0.05, 0.2]]))).toEqual({
      act: true,
      value: {
        disposition: "proceed",
        confidence: 0.8,
        candidates: [
          { index: 1, implements: 0.1, needsChange: 0.9, relevance: 0.9 },
          { index: 2, implements: 0.05, needsChange: 0.2, relevance: 0.2 },
        ],
      },
    });
  });

  test("a proceed needs no corroboration and may have no candidates", () => {
    expect(gate(answers("proceed", 0.95))).toMatchObject({ act: true, value: { candidates: [] } });
  });

  test("abstains for a proceed below the confidence floor", () => {
    expect(gate(answers("proceed", 0.79, [[0.1, 0.9]]))).toMatchObject({ act: false });
  });

  test("acts for a corroborated already-satisfied at the floor", () => {
    expect(PREFLIGHT_CORROBORATION_FLOOR).toBe(0.7);
    expect(gate(answers("already_satisfied", 0.8, [[0.71, 0.1]]))).toMatchObject({
      act: true,
      value: { disposition: "already_satisfied", confidence: 0.8 },
    });
  });

  test("abstains for an already-satisfied that no candidate corroborates", () => {
    expect(gate(answers("already_satisfied", 0.95, []))).toMatchObject({ act: false });
    expect(gate(answers("already_satisfied", 0.95, [[0.7, 0.1], [0.3, 0.9]]))).toMatchObject({ act: false });
  });

  test("abstains for an already-satisfied below the confidence floor even when corroborated", () => {
    expect(gate(answers("already_satisfied", 0.79, [[0.99, 0.01]]))).toMatchObject({ act: false });
  });

  test("abstains for needs-clarification at any confidence", () => {
    for (const confidence of [0.1, 0.8, 0.95, 1]) {
      expect(gate(answers("needs_clarification", confidence, [[0.9, 0.9]]))).toMatchObject({ act: false });
    }
  });

  test("abstains when the disposition is missing or unrecognized", () => {
    expect(gate({})).toMatchObject({ act: false });
    expect(gate(answers("something_else", 0.99))).toMatchObject({ act: false });
    expect(gate({ [Q.disposition]: noul(0.99) })).toMatchObject({ act: false });
  });

  test("the ambiguity rubric never enters the outcome", () => {
    const base = answers("proceed", 0.9, [[0.1, 0.9]]);
    for (const level of [0, 3]) {
      const varied: JudgmentAnswers = { ...base, [Q.ambiguity]: { ...ambiguity, score: level } };
      expect(gate(varied)).toEqual(gate(base));
    }
  });
});

describe("planning.preflight per-candidate answers", () => {
  test("pairs both answers per candidate in order and leaves out a half-answered candidate", () => {
    const partial: JudgmentAnswers = {
      ...answers("proceed", 0.9, [[0.2, 0.6], [0.9, 0.1]]),
      [preflightCandidateQuestionId(3, "implements")]: noul(0.9),
    };
    expect(preflightCandidateAnswers(partial).map(({ index }) => index)).toEqual([1, 2]);
    expect(preflightCandidateAnswers(partial)[1]).toEqual({ index: 2, implements: 0.9, needsChange: 0.1, relevance: 0.9 });
  });
});
