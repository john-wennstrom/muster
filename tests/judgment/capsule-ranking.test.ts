import { describe, expect, test } from "bun:test";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import {
  CAPSULE_AUTHORIZE_AT,
  CAPSULE_DEMOTE_BELOW,
  CAPSULE_OVERSIZED_AT,
  capsuleRankingAnswers,
  capsuleRankingState,
  contextCapsuleRankingDecision,
  judgmentCatalog,
  validateCatalog,
  validateDecision,
} from "../../src/judgment/gates.ts";
import {
  CAPSULE_RANKING_LEVELS,
  capsuleRankingQuestionId,
  capsuleRankingQuestions,
  parseCapsuleRankingQuestionId,
} from "../../src/judgment/questions.ts";

const gate = contextCapsuleRankingDecision.gate;
const scored = (score: number, confidence: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 1 - confidence },
  confidence,
});

describe("context.capsule_ranking questions", () => {
  test("asks one necessity question per slice", () => {
    for (const count of [1, 2, 7, 30]) {
      expect(capsuleRankingQuestions(count)).toHaveLength(count);
      const input = { ...contextCapsuleRankingDecision.representativeInput, slices: Array.from({ length: count }, () => ({ excerpt: "x" })) };
      expect(contextCapsuleRankingDecision.questions(input)).toHaveLength(count);
    }
    expect(Object.keys(validateDecision(contextCapsuleRankingDecision))).toEqual([
      "slice_1_necessity",
      "slice_2_necessity",
    ]);
  });

  test("the wording distinguishes necessary from related and names the four levels in order", () => {
    const question = Object.fromEntries(capsuleRankingQuestions(1))[capsuleRankingQuestionId(1)]!;
    expect(question.type).toBe("score");
    expect(question.instructions).toMatch(/necessary/i);
    expect(question.instructions).toMatch(/needed to do the work/i);
    expect(question.instructions).toMatch(/not that it is topically related/i);
    const criteria = question.type === "score" ? question.criteria : [];
    expect(criteria).toHaveLength(4);
    CAPSULE_RANKING_LEVELS.forEach((level, position) => {
      expect(criteria[position]!.toLowerCase()).toStartWith(level);
    });
  });

  test("question identifiers round-trip and reject anything else", () => {
    expect(parseCapsuleRankingQuestionId(capsuleRankingQuestionId(12))).toBe(12);
    for (const id of ["slice_1", "candidate_1_implements", "slice_x_necessity", "xslice_1_necessity"]) {
      expect(parseCapsuleRankingQuestionId(id)).toBeNull();
    }
  });

  test("is registered in the catalog, which still validates", () => {
    expect(judgmentCatalog).toContain(contextCapsuleRankingDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
  });
});

describe("context.capsule_ranking decision", () => {
  test("declares that it reduces work and adds advice, and nothing that grants", () => {
    expect([...contextCapsuleRankingDecision.effects].sort()).toEqual(["adds_advice", "reduces_work"]);
    expect(contextCapsuleRankingDecision.id).toBe("context.capsule_ranking");
  });

  test("the bands are the ones the specification names", () => {
    expect([CAPSULE_DEMOTE_BELOW, CAPSULE_AUTHORIZE_AT, CAPSULE_OVERSIZED_AT]).toEqual([0.5, 1.5, 2.5]);
  });

  test("the gate returns every scored slice in slice order", () => {
    const answers: JudgmentAnswers = {
      [capsuleRankingQuestionId(2)]: scored(0.2, 0.9),
      [capsuleRankingQuestionId(1)]: scored(2.8, 0.4),
    };
    expect(gate(answers)).toEqual({
      act: true,
      value: { slices: [{ index: 1, score: 2.8, confidence: 0.4 }, { index: 2, score: 0.2, confidence: 0.9 }] },
    });
  });

  test("ignores answers that are not scores for a slice", () => {
    const answers: JudgmentAnswers = {
      [capsuleRankingQuestionId(1)]: { type: "noul", noul: 0.9 },
      other: scored(3, 1),
      [capsuleRankingQuestionId(2)]: scored(Number.NaN, 0.5),
    };
    expect(capsuleRankingAnswers(answers)).toEqual([]);
    expect(gate(answers)).toEqual({ act: false, reason: "no slice was scored" });
  });

  test("the state holds the task contract and each slice's index, optional path, and excerpt only", () => {
    const state = capsuleRankingState({
      task: { ...contextCapsuleRankingDecision.representativeInput.task },
      slices: [{ path: "src/a.ts", excerpt: "1: a" }, { excerpt: "note" }],
    }) as { slices: unknown[]; task: Record<string, unknown> };
    expect(Object.keys(state.task).sort()).toEqual([
      "acceptance", "decisions", "definition", "readScopes", "requirements", "scenarios", "writeScopes",
    ]);
    expect(state.slices).toEqual([{ index: 1, path: "src/a.ts", excerpt: "1: a" }, { index: 2, excerpt: "note" }]);
  });
});
