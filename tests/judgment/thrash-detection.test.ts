import { describe, expect, test } from "bun:test";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import {
  THRASH_HUMAN_NEEDED_ABOVE,
  THRASH_NO_PROGRESS_BELOW,
  THRASH_SAME_CAUSE_ABOVE,
  THRASH_STALLED_ROUNDS,
  debuggingThrashDecision,
  decisionFingerprint,
  judgmentCatalog,
  thrashState,
  validateCatalog,
  validateDecision,
} from "../../src/judgment/gates.ts";
import { THRASH_QUESTION_IDS, thrashQuestions } from "../../src/judgment/questions.ts";

const gate = debuggingThrashDecision.gate;
const noul = (value: number) => ({ type: "noul" as const, noul: value });
const ids = THRASH_QUESTION_IDS;

describe("debugging.thrash questions", () => {
  test("five yes/no questions and one rubric, validated and in the catalog", () => {
    const questions = validateDecision(debuggingThrashDecision);
    expect(Object.keys(questions).sort()).toEqual(Object.values(ids).sort());
    expect(thrashQuestions.filter(([, question]) => question.type === "noul")).toHaveLength(5);
    const fit = questions[ids.fixFit]!;
    expect(fit.type === "score" ? fit.criteria : []).toHaveLength(4);
    expect(judgmentCatalog).toContain(debuggingThrashDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
  });

  test("declares the effects of reducing work and adding caution, and no other", () => {
    expect([...debuggingThrashDecision.effects].sort()).toEqual(["adds_caution", "reduces_work"]);
  });

  test("changing any wording changes the fingerprint", () => {
    const original = decisionFingerprint(debuggingThrashDecision);
    const reworded = {
      ...debuggingThrashDecision,
      questions: () => thrashQuestions.map(([id, question], index) =>
        index === 0 ? [id, { ...question, instructions: `${question.instructions} Also.` }] as const : [id, question] as const),
    };
    expect(decisionFingerprint(reworded)).not.toBe(original);
  });

  test("the bands are the ones the specification names", () => {
    expect(THRASH_SAME_CAUSE_ABOVE).toBe(0.8);
    expect(THRASH_NO_PROGRESS_BELOW).toBe(0.3);
    expect(THRASH_HUMAN_NEEDED_ABOVE).toBe(0.8);
    expect(THRASH_STALLED_ROUNDS).toBe(2);
  });
});

describe("debugging.thrash gate", () => {
  const answered: JudgmentAnswers = {
    [ids.sameRootCause]: noul(0.9),
    [ids.changed]: noul(0.2),
    [ids.progress]: noul(0.1),
    [ids.located]: noul(0.5),
    [ids.humanNeeded]: noul(0.05),
    [ids.fixFit]: { type: "score", score: 2, probabilities: { "2": 0.7 }, confidence: 0.7 },
  };

  test("reports the three gated readings and ignores the other three", () => {
    expect(gate(answered)).toEqual({ act: true, value: { sameRootCause: 0.9, progress: 0.1, humanNeeded: 0.05 } });
    const { [ids.changed]: _changed, [ids.located]: _located, [ids.fixFit]: _fit, ...gatedOnly } = answered;
    expect(gate(gatedOnly)).toEqual(gate(answered));
  });

  test("abstains when a gated answer is missing", () => {
    for (const id of [ids.sameRootCause, ids.progress, ids.humanNeeded]) {
      const { [id]: _omitted, ...rest } = answered;
      expect(gate(rest).act).toBe(false);
    }
  });

  test("the state carries the task, the two failures, and the attempted fix", () => {
    const input = debuggingThrashDecision.representativeInput;
    expect(thrashState(input)).toEqual({
      task: input.taskDefinition,
      previousFailure: { attempt: 1, reproduction: input.previous.reproduction, evidence: [...input.previous.evidence] },
      latestFailure: {
        attempt: 2,
        reproduction: input.latest.reproduction,
        evidence: [...input.latest.evidence],
        attemptedFix: input.latest.attemptedFix,
      },
    });
  });
});
