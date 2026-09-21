import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { judgmentCatalog } from "../../src/judgment/catalog.ts";
import {
  COMMAND_QUESTION_IDS,
  REVIEW_EXTRACTION_QUESTION_IDS,
  REVIEW_TRIAGE_CHANGE_QUESTION_IDS,
  REVIEW_TRIAGE_QUESTION_IDS,
  TASK_FOCUS_QUESTION_IDS,
  PLAN_LINT_COVERAGE_QUESTION_ID,
  TASK_ROUTING_QUESTION_IDS,
  TASK_RECOVERY_QUESTION_IDS,
  TRIAGE_QUESTION_IDS,
} from "../../src/judgment/questions.ts";
import { PROMPTS_ROOT } from "../../src/prompts/render.ts";

/** The identifiers each decision's gate reads, taken from the constants the gate reads them through. */
const GATE_IDENTIFIERS: Readonly<Record<string, readonly string[]>> = {
  "change.triage": Object.values(TRIAGE_QUESTION_IDS),
  "review.task_focus": Object.values(TASK_FOCUS_QUESTION_IDS),
  "command.classification": Object.values(COMMAND_QUESTION_IDS),
  "review.extraction": Object.values(REVIEW_EXTRACTION_QUESTION_IDS),
  "plan.lint": [PLAN_LINT_COVERAGE_QUESTION_ID],
  "review.triage": [...Object.values(REVIEW_TRIAGE_QUESTION_IDS), ...REVIEW_TRIAGE_CHANGE_QUESTION_IDS],
  "routing.task_model": Object.values(TASK_ROUTING_QUESTION_IDS),
  "task.recovery": Object.values(TASK_RECOVERY_QUESTION_IDS),
};

const questionFile = (id: string) => resolve(PROMPTS_ROOT, "judgment", `${id}.yaml`);

describe("judgment question files", () => {
  test("every decision has a question file", () => {
    for (const decision of judgmentCatalog) {
      expect(existsSync(questionFile(decision.id)), `decision ${decision.id}`).toBeTrue();
    }
  });

  test("every identifier a gate reads is present in the decision's questions", () => {
    for (const decision of judgmentCatalog) {
      const present = new Set(decision.questions(decision.representativeInput).map(([id]) => id));
      const read = GATE_IDENTIFIERS[decision.id];
      expect(read, `no gate identifiers declared for ${decision.id}`).toBeDefined();
      for (const identifier of read!) expect(present.has(identifier), `${decision.id} lacks ${identifier}`).toBeTrue();
    }
  });
});
