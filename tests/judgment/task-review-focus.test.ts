import { describe, expect, test } from "bun:test";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { TASK_FOCUS_CATALOGUE, TASK_FOCUS_MAX_ITEMS, reviewTaskFocusDecision, taskFocusState } from "../../src/judgment/decisions/review-task-focus.ts";
import { judgmentCatalog, validateCatalog } from "../../src/judgment/catalog.ts";
import { validateDecision } from "../../src/judgment/decision.ts";
import { TASK_FOCUS_QUESTION_IDS as IDS } from "../../src/judgment/questions.ts";
import { loadQuestions } from "../../src/prompts/questions.ts";

const taskFocusQuestions = loadQuestions("review.task_focus");

const gate = reviewTaskFocusDecision.gate;
const noul = (value: number) => ({ type: "noul" as const, noul: value });
const scored = (score: number, confidence: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 1 - confidence },
  confidence
});

/** Every check passes: good changes answer yes to the first four, no to the last two. */
const passing = (): JudgmentAnswers => ({
  [IDS.scopeContainment]: noul(0.95),
  [IDS.contractMatch]: noul(0.95),
  [IDS.scenarioCoverage]: noul(0.95),
  [IDS.testFirstConsistency]: noul(0.95),
  [IDS.stubOrHardcoded]: noul(0.05),
  [IDS.securityBoundary]: noul(0.05),
  [IDS.reach]: scored(0.2, 0.9)
});

/** The single answer that makes each catalogue entry speak. */
const triggers: Record<string, JudgmentAnswers> = {
  [IDS.securityBoundary]: { [IDS.securityBoundary]: noul(0.9) },
  [IDS.scopeContainment]: { [IDS.scopeContainment]: noul(0.1) },
  [IDS.contractMatch]: { [IDS.contractMatch]: noul(0.1) },
  [IDS.scenarioCoverage]: { [IDS.scenarioCoverage]: noul(0.1) },
  [IDS.testFirstConsistency]: { [IDS.testFirstConsistency]: noul(0.1) },
  [IDS.stubOrHardcoded]: { [IDS.stubOrHardcoded]: noul(0.9) },
  [IDS.reach]: { [IDS.reach]: scored(2.4, 0.8) }
};

const valueOf = (answers: JudgmentAnswers) => {
  const outcome = gate(answers);
  return outcome.act ? outcome.value.items : [];
};

describe("review.task_focus questions", () => {
  test("asks six yes/no questions and one four-level rubric", () => {
    const entries = validateDecision(reviewTaskFocusDecision);
    expect(Object.keys(entries)).toEqual(Object.values(IDS));
    const kinds = taskFocusQuestions.map(([, question]) => question.type);
    expect(kinds.filter((kind) => kind === "noul")).toHaveLength(6);
    const reach = entries[IDS.reach]!;
    expect(reach.type).toBe("score");
    expect(reach.type === "score" ? reach.criteria : []).toHaveLength(4);
  });

  test("declares that it adds advice and can reduce work, at version 2", () => {
    expect(reviewTaskFocusDecision.effects).toEqual(["adds_advice", "reduces_work"]);
    expect(reviewTaskFocusDecision.version).toBe(2);
    expect(reviewTaskFocusDecision.id).toBe("review.task_focus");
  });

  test("is registered in the catalog, which still validates", () => {
    expect(judgmentCatalog).toContain(reviewTaskFocusDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
  });

  test("the state holds exactly the review inputs", () => {
    const state = taskFocusState(reviewTaskFocusDecision.representativeInput) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(
      ["changedPaths", "contract", "diffExcerpt", "scopes", "tddEvidence", "tests"],
    );
  });
});

describe("review.task_focus gate", () => {
  test("every catalogue phrase is reachable, alone, from its own answer", () => {
    for (const entry of TASK_FOCUS_CATALOGUE) {
      const items = valueOf({ ...passing(), ...triggers[entry.id] });
      expect(items.map((item) => item.id)).toEqual([entry.id]);
      expect(items[0]!.phrase).toBe(entry.phrase);
    }
    expect(Object.keys(triggers).sort()).toEqual(TASK_FOCUS_CATALOGUE.map((entry) => entry.id).sort());
  });

  test("a change whose every check passes yields no item and asks to skip the review", () => {
    expect(gate(passing())).toEqual({ act: true, value: { items: [], skip: true } });
  });

  test("the skip needs every question confidently good, so one uncertain answer refuses it", () => {
    const uncertain: JudgmentAnswers[] = [
      { [IDS.scopeContainment]: noul(0.5) },
      { [IDS.contractMatch]: noul(0.5) },
      { [IDS.scenarioCoverage]: noul(0.5) },
      { [IDS.testFirstConsistency]: noul(0.5) },
      { [IDS.stubOrHardcoded]: noul(0.5) },
      { [IDS.securityBoundary]: noul(0.5) },
      { [IDS.reach]: scored(0.2, 0.5) },
    ];
    for (const change of uncertain) expect(gate({ ...passing(), ...change })).toEqual({ act: false, reason: "no check crossed its threshold" });
  });

  test("a missing answer refuses the skip", () => {
    for (const id of Object.values(IDS)) {
      const { [id]: _removed, ...without } = passing();
      expect(gate(without).act).toBeFalse();
    }
  });

  test("the skip bands are inclusive at the confident edges", () => {
    expect(gate({ ...passing(), [IDS.contractMatch]: noul(0.7), [IDS.securityBoundary]: noul(0.3) })).toMatchObject({ value: { skip: true } });
    expect(gate({ ...passing(), [IDS.reach]: scored(1.99, 0.7) })).toMatchObject({ value: { skip: true } });
  });

  test("a change with a speaking item never skips", () => {
    for (const trigger of Object.values(triggers)) {
      expect(gate({ ...passing(), ...trigger })).toMatchObject({ value: { skip: false } });
    }
  });

  test("uncertain answers yield no item, including at the band edges", () => {
    const uncertain: JudgmentAnswers = {
      [IDS.scopeContainment]: noul(0.3),
      [IDS.contractMatch]: noul(0.5),
      [IDS.scenarioCoverage]: noul(0.7),
      [IDS.testFirstConsistency]: noul(0.3),
      [IDS.stubOrHardcoded]: noul(0.7),
      [IDS.securityBoundary]: noul(0.5),
      [IDS.reach]: scored(3, 0.69),
    };
    expect(gate(uncertain).act).toBeFalse();
    expect(gate({ ...uncertain, [IDS.reach]: scored(1.9, 0.99) }).act).toBeFalse();
  });

  test("the reach rubric speaks at 2.0 with confidence 0.7", () => {
    expect(valueOf({ [IDS.reach]: scored(2.0, 0.7) })).toHaveLength(1);
    expect(valueOf({ [IDS.reach]: scored(2.0, 0.69) })).toHaveLength(0);
    expect(valueOf({ [IDS.reach]: scored(1.99, 0.9) })).toHaveLength(0);
  });

  test("a missing or mistyped answer adds nothing", () => {
    expect(gate({}).act).toBeFalse();
    expect(gate({ [IDS.securityBoundary]: scored(3, 1) }).act).toBeFalse();
    expect(gate({ [IDS.reach]: noul(1) }).act).toBeFalse();
  });

  test("five or more triggered answers yield exactly four, in priority order", () => {
    const all = Object.values(triggers).reduce((merged, one) => ({ ...merged, ...one }), {});
    const items = valueOf(all);
    expect(items).toHaveLength(TASK_FOCUS_MAX_ITEMS);
    expect(items.map((item) => item.id)).toEqual([
      IDS.securityBoundary,
      IDS.scopeContainment,
      IDS.contractMatch,
      IDS.scenarioCoverage,
    ]);
    const five = valueOf({ ...triggers[IDS.reach], ...triggers[IDS.stubOrHardcoded], ...triggers[IDS.testFirstConsistency], ...triggers[IDS.scenarioCoverage], ...triggers[IDS.contractMatch] });
    expect(five.map((item) => item.id)).toEqual([
      IDS.contractMatch,
      IDS.scenarioCoverage,
      IDS.testFirstConsistency,
      IDS.stubOrHardcoded,
    ]);
  });

  test("no item contains model-written text", () => {
    const phrases = new Set(TASK_FOCUS_CATALOGUE.map((entry) => entry.phrase));
    const all = Object.values(triggers).reduce((merged, one) => ({ ...merged, ...one }), {});
    for (const item of valueOf(all)) {
      expect(phrases.has(item.phrase)).toBeTrue();
      expect(Object.keys(item).sort()).toEqual(["area", "id", "phrase"]);
    }
  });
});
