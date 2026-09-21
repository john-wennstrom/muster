import { describe, expect, test } from "bun:test";
import { HarnessError } from "../../src/shared/errors.ts";
import { classifyFailure } from "../../src/change/failure-classification.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { abstain, act, decisionFingerprint, decisionKey, defineDecision, noulBand, noulOf, scoreOf, validateDecision, type AnyDecision } from "../../src/judgment/decision.ts";
import { judgmentCatalog, validateCatalog } from "../../src/judgment/catalog.ts";
import {
  choice,
  noul,
  score,
  validateQuestions,
  type QuestionEntry,
} from "../../src/judgment/questions.ts";

interface SampleInput {
  request: string;
}

/** Test-only decision, so these tests do not depend on a production decision's wording. */
function sampleDecision(overrides: Partial<AnyDecision> = {}) {
  return defineDecision<SampleInput, "escalate">({
    id: "test.sample",
    version: 1,
    effects: ["adds_caution", "reduces_work"],
    representativeInput: { request: "Change the wire format between broker and child" },
    questions: () => [
      ["public_contract", noul("Does the request change a contract that code outside this repository depends on?")],
      ["disposition", choice("What should happen with this request?", { proceed: "Plan it.", clarify: null })],
      ["materiality", score("How material is the change?", ["Cosmetic", "Minor", "Material"])],
    ],
    gate: (answers) => {
      const value = noulOf(answers, "public_contract");
      const band = value === null ? "uncertain" : noulBand(value, { yes: 0.7, no: 0.3 });
      return band === "yes" ? act("escalate") : abstain(`public_contract is ${band}`);
    },
    ...overrides,
  } as never);
}

function expectInvalid(run: () => unknown, decision: string, question: string | null) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).code).toBe("JUDGMENT_QUESTION_INVALID");
    expect((error as HarnessError).details).toEqual({ decision, question });
    return;
  }
  throw new Error("expected a JUDGMENT_QUESTION_INVALID error");
}

describe("question validation", () => {
  const ok = noul("Is it so?");

  test("rejects a duplicate identifier naming the decision and identifier", () => {
    expectInvalid(() => validateQuestions("test.dup", [["a", ok], ["a", ok]]), "test.dup", "a");
  });

  test("rejects an unsupported type", () => {
    expectInvalid(
      () => validateQuestions("test.type", [["a", { type: "essay", instructions: "Write" } as never]]),
      "test.type",
      "a",
    );
  });

  test("rejects a choice without options", () => {
    expectInvalid(() => validateQuestions("test.choice", [["a", choice("Which?", {})]]), "test.choice", "a");
  });

  test("rejects a rubric without criteria", () => {
    expectInvalid(() => validateQuestions("test.score", [["a", score("How much?", [])]]), "test.score", "a");
  });

  test("rejects an empty question and an empty identifier", () => {
    expectInvalid(() => validateQuestions("test.empty", [["a", noul("   ")]]), "test.empty", "a");
    expectInvalid(() => validateQuestions("test.id", [[" ", ok]]), "test.id", " ");
  });

  test("rejects a decision with no questions", () => {
    expectInvalid(() => validateQuestions("test.none", []), "test.none", null);
  });

  test("accepts well-formed questions of every type", () => {
    const entries: QuestionEntry[] = [
      ["n", ok],
      ["c", choice("Which?", { a: "Option a", b: null })],
      ["s", score("How much?", ["low", "high"])],
    ];
    expect(Object.keys(validateQuestions("test.ok", entries))).toEqual(["n", "c", "s"]);
  });

  test("the error code is an internal fault with no blocker", () => {
    expect(classifyFailure("JUDGMENT_QUESTION_INVALID")).toEqual({ blocker: null });
  });
});

describe("decision registry", () => {
  test("every catalogued decision builds and validates from representative input", () => {
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
  });

  test("the sample decision builds and validates", () => {
    const decision = sampleDecision();
    expect(Object.keys(validateDecision(decision))).toEqual(["public_contract", "disposition", "materiality"]);
    expect(() => validateCatalog([decision])).not.toThrow();
  });

  test("rejects a duplicate decision identifier in the catalog", () => {
    expectInvalid(() => validateCatalog([sampleDecision(), sampleDecision()]), "test.sample", null);
  });

  test("rejects a decision that does not declare its effects", () => {
    expectInvalid(() => validateDecision(sampleDecision({ effects: [] })), "test.sample", null);
  });

  test("rejects an effect that grants, and only the three effects exist", () => {
    for (const effect of ["grants_permission", "removes_checkpoint", "relaxes_check"]) {
      expectInvalid(
        () => validateDecision(sampleDecision({ effects: [effect] as never })),
        "test.sample",
        null,
      );
    }
    for (const effect of ["adds_caution", "adds_advice", "reduces_work"] as const) {
      expect(() => validateDecision(sampleDecision({ effects: [effect] }))).not.toThrow();
    }
  });

  test("rejects a version that is not a positive integer", () => {
    expectInvalid(() => validateDecision(sampleDecision({ version: 0 })), "test.sample", null);
  });

  test("surfaces a malformed question built from representative input", () => {
    const decision = sampleDecision({ questions: () => [["a", noul("")]] });
    expectInvalid(() => validateDecision(decision), "test.sample", "a");
  });

  test("a version change changes the decision's identity", () => {
    expect(decisionKey(sampleDecision({ version: 1 }))).toBe("test.sample@v1");
    expect(decisionKey(sampleDecision({ version: 2 }))).toBe("test.sample@v2");
  });

  test("changing question wording changes the fingerprint", () => {
    const original = sampleDecision();
    const reworded = sampleDecision({
      questions: () => [["public_contract", noul("Does the request change a public contract?")]],
    });
    expect(decisionFingerprint(original)).toBe(decisionFingerprint(sampleDecision()));
    expect(decisionFingerprint(reworded)).not.toBe(decisionFingerprint(original));
  });
});

describe("gates", () => {
  const answers = (value: number): JudgmentAnswers => ({
    public_contract: { type: "noul", noul: value },
  });

  test("acts when a probability clears its band", () => {
    expect(sampleDecision().gate(answers(0.9))).toEqual({ act: true, value: "escalate" });
  });

  test("abstains in the uncertain band and on the confident-no side", () => {
    expect(sampleDecision().gate(answers(0.5))).toEqual({ act: false, reason: "public_contract is uncertain" });
    expect(sampleDecision().gate(answers(0.1))).toEqual({ act: false, reason: "public_contract is no" });
  });

  test("abstains when the answer is missing", () => {
    expect(sampleDecision().gate({})).toMatchObject({ act: false });
  });

  test("bands are inclusive at their edges", () => {
    expect(noulBand(0.7, { yes: 0.7, no: 0.3 })).toBe("yes");
    expect(noulBand(0.3, { yes: 0.7, no: 0.3 })).toBe("no");
    expect(noulBand(0.5, { yes: 0.7, no: 0.3 })).toBe("uncertain");
  });

  test("typed accessors return null for the wrong type", () => {
    expect(scoreOf(answers(0.5), "public_contract")).toBeNull();
    expect(noulOf({ s: { type: "score", score: 1, probabilities: {}, confidence: 1 } }, "s")).toBeNull();
  });
});
