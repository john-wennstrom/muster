import { HarnessError } from "../shared/errors.ts";
import type { JsonValue, JudgmentAnswer, JudgmentAnswers, JudgmentQuestions } from "./client.ts";
import { questionsFingerprint, validateQuestions, type QuestionEntry } from "./questions.ts";

/**
 * Decision definitions and their confidence bands. Bands are constants next to the decision
 * that uses them, in this one reviewable place. A gate is pure: answers in, an act-or-abstain
 * outcome out. Abstaining always means the caller does what it does without judgment.
 */

/**
 * What acting can do. The vocabulary has no member that grants a permission, removes a
 * manual checkpoint, or relaxes an existing check; that absence is what "answers never grant
 * permission" means for a reviewer. A decision that can reduce work must abstain into the
 * full, unreduced activity.
 */
export const JUDGMENT_EFFECTS = ["adds_caution", "adds_advice", "reduces_work"] as const;
export type JudgmentEffect = (typeof JUDGMENT_EFFECTS)[number];

export type GateOutcome<Value> =
  | { readonly act: true; readonly value: Value }
  | { readonly act: false; readonly reason: string };

export function act<Value>(value: Value): GateOutcome<Value> {
  return { act: true, value };
}

export function abstain(reason: string): GateOutcome<never> {
  return { act: false, reason };
}

export interface Decision<Input, Value> {
  /** Names the decision in records, fixtures, and summaries; unique in the catalog. */
  readonly id: string;
  /** Bumped whenever question wording or confidence bands change. */
  readonly version: number;
  readonly effects: readonly JudgmentEffect[];
  /** Input from which the registry test builds and validates this decision's questions. */
  readonly representativeInput: Input;
  readonly questions: (input: Input) => readonly QuestionEntry[];
  /** The state sent with the questions, as the call site builds it. */
  readonly state: (input: Input) => JsonValue;
  readonly gate: (answers: JudgmentAnswers) => GateOutcome<Value>;
}

export type AnyDecision = Decision<any, unknown>;

export function defineDecision<Input, Value>(
  decision: Decision<Input, Value>,
): Decision<Input, Value> {
  return Object.freeze({ ...decision, effects: Object.freeze([...decision.effects]) });
}

export function decisionKey(decision: Pick<AnyDecision, "id" | "version">): string {
  return `${decision.id}@v${decision.version}`;
}

export function invalidDecision(decision: string, message: string): never {
  throw new HarnessError("JUDGMENT_QUESTION_INVALID", `Judgment decision ${decision}: ${message}`, {
    decision,
    question: null,
  });
}

/** Builds a decision's questions from its representative input and validates everything. */
export function validateDecision(decision: AnyDecision): JudgmentQuestions {
  if (!decision.id?.trim()) invalidDecision(String(decision.id), "has an empty identifier");
  if (!Number.isInteger(decision.version) || decision.version < 1) {
    invalidDecision(decision.id, "needs a positive integer version");
  }
  if (!Array.isArray(decision.effects) || decision.effects.length === 0) {
    invalidDecision(decision.id, "does not declare its effects");
  }
  for (const effect of decision.effects) {
    if (!(JUDGMENT_EFFECTS as readonly string[]).includes(effect)) {
      invalidDecision(decision.id, `declares unsupported effect ${String(effect)}`);
    }
  }
  return validateQuestions(decision.id, decision.questions(decision.representativeInput));
}

/** Validates every decision and that identifiers are unique across the catalog. */
export function decisionFingerprint(decision: AnyDecision): string {
  return questionsFingerprint(validateDecision(decision));
}

/** Bands for a probability: at or above `yes` acts as yes, at or below `no` as no. */
export function noulBand(value: number, bands: { readonly yes: number; readonly no: number }): "yes" | "no" | "uncertain" {
  if (value >= bands.yes) return "yes";
  if (value <= bands.no) return "no";
  return "uncertain";
}

export function noulOf(answers: JudgmentAnswers, id: string): number | null {
  const answer: JudgmentAnswer | undefined = answers[id];
  return answer?.type === "noul" ? answer.noul : null;
}

export function choiceOf(
  answers: JudgmentAnswers,
  id: string,
): { readonly choice: string; readonly confidence: number } | null {
  const answer: JudgmentAnswer | undefined = answers[id];
  return answer?.type === "choice" ? { choice: answer.choice, confidence: answer.confidence } : null;
}

export function scoreOf(
  answers: JudgmentAnswers,
  id: string,
): { readonly score: number; readonly confidence: number } | null {
  const answer: JudgmentAnswer | undefined = answers[id];
  return answer?.type === "score" ? { score: answer.score, confidence: answer.confidence } : null;
}
