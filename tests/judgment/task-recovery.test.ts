import { describe, expect, test } from "bun:test";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { judgmentCatalog, validateCatalog } from "../../src/judgment/catalog.ts";
import { validateDecision } from "../../src/judgment/decision.ts";
import { TASK_RECOVERY_CONFIDENCE_AT_LEAST, taskRecoveryDecision, taskRecoveryState } from "../../src/judgment/decisions/task-recovery.ts";
import { TASK_RECOVERY_ACTIONS, TASK_RECOVERY_QUESTION_IDS as IDS } from "../../src/judgment/questions.ts";

const gate = taskRecoveryDecision.gate;
const choice = (value: string, confidence: number): JudgmentAnswers => ({ [IDS.nextStep]: { type: "choice", choice: value, probabilities: { [value]: confidence }, confidence } });

describe("task.recovery decision", () => {
  test("is registered and valid, asks one choice and one recorded yes/no, and only adds caution", () => {
    expect(judgmentCatalog).toContain(taskRecoveryDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
    expect(taskRecoveryDecision.effects).toEqual(["adds_caution"]);
    const questions = validateDecision(taskRecoveryDecision);
    expect(Object.keys(questions).sort()).toEqual([IDS.humanNeeded, IDS.nextStep].sort());
    const next = questions[IDS.nextStep]!;
    expect(next.type === "choice" ? Object.keys(next.criteria) : []).toEqual([...TASK_RECOVERY_ACTIONS]);
  });

  test("the state is the task, its lane and the failure text", () => {
    const state = taskRecoveryState(taskRecoveryDecision.representativeInput) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["failure", "lane", "task"]);
  });
});

describe("task.recovery gate", () => {
  test("each recognized action acts when confident", () => {
    for (const action of TASK_RECOVERY_ACTIONS) {
      expect(gate(choice(action, 0.9))).toEqual({ act: true, value: { action, confidence: 0.9 } });
    }
  });

  test("the band is inclusive at its edge and abstains below it", () => {
    expect(gate(choice("retry", TASK_RECOVERY_CONFIDENCE_AT_LEAST)).act).toBe(true);
    expect(gate(choice("retry", TASK_RECOVERY_CONFIDENCE_AT_LEAST - 0.01)).act).toBe(false);
  });

  test("a missing or unrecognized choice abstains", () => {
    expect(gate({}).act).toBe(false);
    expect(gate(choice("give_up", 0.99)).act).toBe(false);
    expect(gate({ [IDS.nextStep]: { type: "noul", noul: 0.9 } }).act).toBe(false);
  });

  test("the recorded yes/no answer never changes the outcome", () => {
    const withHuman = { ...choice("retry", 0.9), [IDS.humanNeeded]: { type: "noul" as const, noul: 0.99 } };
    expect(gate(withHuman)).toEqual(gate(choice("retry", 0.9)));
  });
});
