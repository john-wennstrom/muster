import { describe, expect, test } from "bun:test";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import {
  COMMAND_UNCERTAIN_NONE_BELOW,
  commandClassificationDecision,
  commandState,
  isUncertainNone,
  judgmentCatalog,
  validateCatalog,
  validateDecision,
} from "../../src/judgment/gates.ts";
import {
  COMMAND_CATEGORIES,
  COMMAND_QUESTION_IDS as IDS,
} from "../../src/judgment/questions.ts";

const gate = commandClassificationDecision.gate;
const chose = (choice: string, confidence: number) => ({
  type: "choice" as const,
  choice,
  probabilities: { [choice]: confidence },
  confidence,
});
const noul = (value: number) => ({ type: "noul" as const, noul: value });

describe("command.classification questions", () => {
  test("asks one category choice over the five categories and three yes/no questions", () => {
    const questions = validateDecision(commandClassificationDecision);
    expect(Object.keys(questions)).toEqual(Object.values(IDS));
    const category = questions[IDS.category]!;
    expect(category.type).toBe("choice");
    expect(category.type === "choice" ? Object.keys(category.criteria) : []).toEqual([
      "none", "authentication", "elevated_permission", "destructive", "external_side_effect",
    ]);
    expect(category.type === "choice" ? Object.values(category.criteria).every(Boolean) : false).toBeTrue();
    for (const id of [IDS.irreversible, IDS.remoteMutation, IDS.credentialUse]) {
      expect(questions[id]!.type).toBe("noul");
    }
  });

  test("declares that it only adds caution and is registered in the catalog", () => {
    expect(commandClassificationDecision.effects).toEqual(["adds_caution"]);
    expect(commandClassificationDecision.id).toBe("command.classification");
    expect(judgmentCatalog).toContain(commandClassificationDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
  });

  test("the state holds exactly the command's shape", () => {
    const state = commandState(commandClassificationDecision.representativeInput) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["args", "cwd", "executable", "profile"]);
  });
});

describe("command.classification gate", () => {
  test("every category other than none acts, at any confidence", () => {
    for (const category of COMMAND_CATEGORIES.filter((name) => name !== "none")) {
      for (const confidence of [0, 0.1, 0.4, 0.69, 0.7, 0.99, 1]) {
        const outcome = gate({ [IDS.category]: chose(category, confidence) });
        expect(outcome).toEqual({ act: true, value: { category, confidence } });
      }
    }
  });

  test("a low-confidence category still acts", () => {
    expect(gate({ [IDS.category]: chose("destructive", 0.4) })).toEqual({
      act: true,
      value: { category: "destructive", confidence: 0.4 },
    });
  });

  test("none abstains at every confidence, marking an uncertain none for calibration", () => {
    for (const confidence of [0, 0.5, 0.69, 0.7, 0.95, 1]) {
      const outcome = gate({ [IDS.category]: chose("none", confidence) });
      expect(outcome.act).toBeFalse();
      const reason = outcome.act ? "" : outcome.reason;
      expect(isUncertainNone(reason)).toBe(confidence < COMMAND_UNCERTAIN_NONE_BELOW);
    }
  });

  test("the yes/no answers never enter the outcome", () => {
    const yes: JudgmentAnswers = {
      [IDS.irreversible]: noul(1),
      [IDS.remoteMutation]: noul(1),
      [IDS.credentialUse]: noul(1),
    };
    expect(gate({ ...yes, [IDS.category]: chose("none", 0.95) }).act).toBeFalse();
    expect(gate(yes).act).toBeFalse();
    const withYes = gate({ ...yes, [IDS.category]: chose("authentication", 0.9) });
    const without = gate({ [IDS.category]: chose("authentication", 0.9) });
    expect(withYes).toEqual(without);
    const no: JudgmentAnswers = {
      [IDS.irreversible]: noul(0),
      [IDS.remoteMutation]: noul(0),
      [IDS.credentialUse]: noul(0),
    };
    expect(gate({ ...no, [IDS.category]: chose("destructive", 0.9) })).toEqual(
      gate({ [IDS.category]: chose("destructive", 0.9) }),
    );
  });

  test("a missing, mistyped, or unrecognized category abstains", () => {
    expect(gate({}).act).toBeFalse();
    expect(gate({ [IDS.category]: noul(1) }).act).toBeFalse();
    expect(gate({ [IDS.category]: chose("everything", 1) }).act).toBeFalse();
  });
});
