import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import {
  COMPLEXITY_BANDS,
  complexityState,
  decisionFingerprint,
  planningComplexityDecision,
  validateDecision,
  type ComplexityInput,
} from "../../src/judgment/gates.ts";
import { COMPLEXITY_QUESTION_IDS as Q, complexityQuestions } from "../../src/judgment/questions.ts";
import { createReplayClient } from "../../src/judgment/replay.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const evidence = [{ path: "src/search/view.ts", reason: "Current behavior differs." }];
const enforce = { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "sk-test", MUSTER_JEV_MODE: "enforce" };

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const reach = (score: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 },
  confidence: 0.8,
});

/** Every answer uncertain, then overridden; keeps each test to the answers it is about. */
function answers(overrides: Record<string, number> = {}): JudgmentAnswers {
  const base: Record<string, number> = {
    [Q.publicContract]: 0.5,
    [Q.dataMigration]: 0.5,
    [Q.securityBoundary]: 0.5,
    [Q.designAmbiguity]: 0.5,
    ...overrides,
  };
  return {
    ...Object.fromEntries(Object.entries(base).map(([id, value]) => [id, noul(value)])),
    [Q.mechanical]: noul(overrides[Q.mechanical] ?? 0.5),
    [Q.reach]: reach(1),
  };
}

const gate = planningComplexityDecision.gate;

describe("planning.complexity questions", () => {
  test("asks the four risk questions and the two recorded-only questions", () => {
    expect(Object.keys(validateDecision(planningComplexityDecision))).toEqual([
      "public_contract",
      "data_migration",
      "security_boundary",
      "design_ambiguity",
      "mechanical",
      "reach",
    ]);
    const questions = Object.fromEntries(complexityQuestions);
    expect(questions[Q.mechanical]?.type).toBe("noul");
    const reachQuestion = questions[Q.reach];
    expect(reachQuestion?.type).toBe("score");
    expect(reachQuestion?.type === "score" && reachQuestion.criteria).toHaveLength(4);
  });

  test("the migration question says a request that avoids a migration answers no", () => {
    const wording = Object.fromEntries(complexityQuestions)[Q.dataMigration]!.instructions;
    expect(wording).toMatch(/explicitly avoids a migration/i);
    expect(wording).toMatch(/answers no/i);
  });

  test("the public-contract question says an internal signature is not a public contract", () => {
    const wording = Object.fromEntries(complexityQuestions)[Q.publicContract]!.instructions;
    expect(wording).toMatch(/internal function signature/i);
    expect(wording).toMatch(/not a public contract change and answers no/i);
  });

  test("the security question is limited to what is allowed or trusted", () => {
    expect(Object.fromEntries(complexityQuestions)[Q.securityBoundary]!.instructions)
      .toMatch(/what an actor is allowed to do, or what the system trusts/i);
  });

  test("the ambiguity question asks about incompatible designs", () => {
    expect(Object.fromEntries(complexityQuestions)[Q.designAmbiguity]!.instructions)
      .toMatch(/mutually incompatible designs/i);
  });

  test("changing any wording changes the decision's fingerprint", () => {
    expect(decisionFingerprint(planningComplexityDecision)).toBe(decisionFingerprint(planningComplexityDecision));
    const reworded = { ...planningComplexityDecision, questions: () => complexityQuestions.slice(1) };
    expect(decisionFingerprint(reworded)).not.toBe(decisionFingerprint(planningComplexityDecision));
  });
});

describe("planning.complexity effects", () => {
  test("declares that it adds caution and reduces work", () => {
    expect([...planningComplexityDecision.effects]).toEqual(["adds_caution", "reduces_work"]);
  });
});

describe("planning.complexity gate", () => {
  test("maps above 0.7 to true and below 0.3 to false", () => {
    expect(gate(answers({
      [Q.publicContract]: 0.91,
      [Q.dataMigration]: 0.04,
      [Q.securityBoundary]: 0.99,
      [Q.designAmbiguity]: 0.01,
    }))).toEqual({
      act: true,
      value: {
        hasPublicContractChange: true,
        hasDataMigration: false,
        hasSecurityBoundaryChange: true,
        hasDesignAmbiguity: false,
      },
    });
  });

  test("leaves an uncertain signal out of the outcome without affecting the others", () => {
    expect(gate(answers({ [Q.publicContract]: 0.9, [Q.dataMigration]: 0.5 }))).toEqual({
      act: true,
      value: { hasPublicContractChange: true },
    });
  });

  test("the bands are exclusive: 0.3 and 0.7 themselves are uncertain", () => {
    expect(COMPLEXITY_BANDS).toEqual({ yes: 0.7, no: 0.3 });
    expect(gate(answers({ [Q.publicContract]: 0.7, [Q.dataMigration]: 0.3 })).act).toBe(false);
    expect(gate(answers({ [Q.publicContract]: 0.7001, [Q.dataMigration]: 0.2999 }))).toEqual({
      act: true,
      value: { hasPublicContractChange: true, hasDataMigration: false },
    });
  });

  test("abstains when no signal is confident and when answers are missing", () => {
    expect(gate(answers())).toMatchObject({ act: false });
    expect(gate({})).toMatchObject({ act: false });
  });

  test("the recorded-only answers never enter the outcome", () => {
    const uncertain = answers();
    for (const extreme of [0, 1]) {
      const varied: JudgmentAnswers = {
        ...uncertain,
        [Q.mechanical]: noul(extreme),
        [Q.reach]: reach(extreme * 3),
      };
      expect(gate(varied)).toEqual(gate(uncertain));
    }
    const confident = answers({ [Q.publicContract]: 0.95 });
    expect(gate({ ...confident, [Q.mechanical]: noul(0), [Q.reach]: reach(3) })).toEqual(gate(confident));
  });
});

describe("planning.complexity replayed responses", () => {
  async function judged(request: string, phase: ComplexityInput["phase"] = "propose") {
    const directory = await mkdtemp(join(tmpdir(), "judgment-complexity-"));
    directories.push(directory);
    const runtime = createJudgmentRuntime({
      env: enforce,
      store: new AtomicJsonStore(directory),
      client: createReplayClient(),
    });
    const input: ComplexityInput = { request, phase, evidence };
    return runtime.judge(planningComplexityDecision, {
      input,
      changeName: "add-search",
      phase: "planning",
      state: complexityState(input),
      sourcePaths: evidence.map(({ path }) => path),
    });
  }

  test("an avoided migration yields a false migration input", async () => {
    const verdict = await judged("don't migrate the data, just add a column");
    expect(verdict).toMatchObject({ kind: "enforce", outcome: { act: true } });
    const outcome = verdict.kind === "enforce" && verdict.outcome.act ? verdict.outcome.value : null;
    expect(outcome?.hasDataMigration).toBe(false);
  });

  test("an internal signature change yields a false public-contract input", async () => {
    const verdict = await judged("rename an internal function signature in the parser");
    const outcome = verdict.kind === "enforce" && verdict.outcome.act ? verdict.outcome.value : null;
    expect(outcome?.hasPublicContractChange).toBe(false);
  });

  test("a wire format change yields a true public-contract input and leaves security uncertain", async () => {
    const verdict = await judged("change the wire format between the broker and the child");
    const outcome = verdict.kind === "enforce" && verdict.outcome.act ? verdict.outcome.value : null;
    expect(outcome?.hasPublicContractChange).toBe(true);
    expect(outcome).not.toHaveProperty("hasSecurityBoundaryChange");
  });
});
