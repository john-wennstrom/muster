import type { JsonValue, JudgmentAnswers } from "../client.ts";
import { abstain, act, choiceOf, defineDecision, noulOf, scoreOf } from "../decision.ts";
import {
  parseTriageCandidateQuestionId,
  TRIAGE_QUESTION_IDS,
  type TriageDisposition,
} from "../questions.ts";
import { loadQuestions } from "../../prompts/questions.ts";

/**
 * change.triage: how a change should be planned, decided once before any agent runs. It answers
 * the disposition (proceed, already satisfied, needs clarification), the four planning risks,
 * whether the change is mechanical and how far it reaches, over candidate files that code
 * retrieved. The gate's value always carries what was judged with confidence, so the lane can use
 * the risks and the reach whatever the disposition. Only two dispositions may act: a confident
 * proceed, and a confident already-satisfied that at least one candidate corroborates.
 * Clarification never acts at any confidence, because its product is a question that judgment
 * cannot write. The constants are starting points for calibration.
 */
export const TRIAGE_DISPOSITION_FLOOR = 0.8;
export const TRIAGE_CORROBORATION_FLOOR = 0.7;
export const TRIAGE_RELEVANCE_FLOOR = 0.5;
/** A yes/no risk answer is confident only strictly above or below these. */
export const TRIAGE_RISK_BANDS = { yes: 0.7, no: 0.3 } as const;
export const TRIAGE_REACH_CONFIDENCE = 0.7;

export interface TriageCandidateInput {
  readonly path: string;
  readonly excerpt: string;
}

export interface TriageInput {
  readonly request: string;
  readonly phase: "propose" | "refine";
  readonly candidates: readonly TriageCandidateInput[];
}

/** The state sent: the request, the phase, and each candidate's path and excerpt. Nothing else. */
export function triageState(input: TriageInput): JsonValue {
  return {
    request: input.request,
    phase: input.phase,
    candidates: input.candidates.map(({ path, excerpt }, position) => ({ index: position + 1, path, excerpt })),
  };
}

export interface TriageCandidateAnswer {
  /** One-based, matching the candidate's index in the state. */
  readonly index: number;
  /** Probability that the candidate already implements the request. */
  readonly implements: number;
  /** Probability that the candidate would need to change. */
  readonly needsChange: number;
  /** The higher of the two: how likely the candidate matters to the request at all. */
  readonly relevance: number;
}

/** The per-candidate answers, in candidate order; a candidate missing either answer is left out. */
export function triageCandidateAnswers(answers: JudgmentAnswers): TriageCandidateAnswer[] {
  const partial = new Map<number, { implements?: number; needsChange?: number }>();
  for (const id of Object.keys(answers)) {
    const parsed = parseTriageCandidateQuestionId(id);
    const value = noulOf(answers, id);
    if (!parsed || value === null) continue;
    const entry = partial.get(parsed.index) ?? {};
    if (parsed.kind === "implements") entry.implements = value;
    else entry.needsChange = value;
    partial.set(parsed.index, entry);
  }
  return [...partial.entries()]
    .filter((pair): pair is [number, Required<{ implements: number; needsChange: number }>] =>
      pair[1].implements !== undefined && pair[1].needsChange !== undefined)
    .sort(([left], [right]) => left - right)
    .map(([index, { implements: implemented, needsChange }]) => ({
      index,
      implements: implemented,
      needsChange,
      relevance: Math.max(implemented, needsChange),
    }));
}

export interface TriageRisks {
  hasPublicContractChange?: boolean;
  hasDataMigration?: boolean;
  hasSecurityBoundaryChange?: boolean;
  hasDesignAmbiguity?: boolean;
}

export const TRIAGE_RISK_QUESTIONS = [
  ["hasPublicContractChange", TRIAGE_QUESTION_IDS.publicContract],
  ["hasDataMigration", TRIAGE_QUESTION_IDS.dataMigration],
  ["hasSecurityBoundaryChange", TRIAGE_QUESTION_IDS.securityBoundary],
  ["hasDesignAmbiguity", TRIAGE_QUESTION_IDS.designAmbiguity],
] as const satisfies readonly (readonly [keyof TriageRisks, string])[];

export interface TriageGateValue {
  /** Set only when the disposition may act; null means the preflight agent runs. */
  readonly disposition: Exclude<TriageDisposition, "needs_clarification"> | null;
  readonly dispositionConfidence: number | null;
  readonly candidates: readonly TriageCandidateAnswer[];
  /** Only the risk inputs judged confidently; an absent key is uncertain. */
  readonly risks: TriageRisks;
  /** The confident answer to the mechanical question, when there is one. */
  readonly mechanical?: boolean;
  /** The confidently judged reach level, zero (one function or file) to three (beyond the repository). */
  readonly reach?: number;
}

/** Strictly above and strictly below the bands; the edges themselves are uncertain. */
function confidentAnswer(value: number | null): boolean | undefined {
  if (value === null) return undefined;
  if (value > TRIAGE_RISK_BANDS.yes) return true;
  if (value < TRIAGE_RISK_BANDS.no) return false;
  return undefined;
}

function actingDisposition(answers: JudgmentAnswers): Pick<TriageGateValue, "disposition" | "dispositionConfidence"> {
  const none = { disposition: null, dispositionConfidence: null } as const;
  const disposition = choiceOf(answers, TRIAGE_QUESTION_IDS.disposition);
  if (!disposition || disposition.confidence < TRIAGE_DISPOSITION_FLOOR) return none;
  if (disposition.choice === "proceed") return { disposition: "proceed", dispositionConfidence: disposition.confidence };
  if (
    disposition.choice === "already_satisfied"
    && triageCandidateAnswers(answers).some((candidate) => candidate.implements > TRIAGE_CORROBORATION_FLOOR)
  ) {
    return { disposition: "already_satisfied", dispositionConfidence: disposition.confidence };
  }
  return none;
}

export const changeTriageDecision = defineDecision<TriageInput, TriageGateValue>({
  id: "change.triage",
  version: 1,
  // A confident yes the patterns missed adds caution; a confident proceed skips a mandatory agent run.
  effects: ["adds_caution", "reduces_work"],
  representativeInput: {
    request: "Retry `parseInvoice` when the invoice_total is missing",
    phase: "propose",
    candidates: [
      { path: "src/billing/invoice.ts", excerpt: "12: export function parseInvoice(input) {" },
      { path: "src/billing/retry.ts", excerpt: "3: export function withRetry(work) {" },
    ],
  },
  questions: (input) => loadQuestions("change.triage", { candidates: input.candidates }),
  state: triageState,
  gate: (answers) => {
    const risks: TriageRisks = {};
    for (const [key, question] of TRIAGE_RISK_QUESTIONS) {
      const value = confidentAnswer(noulOf(answers, question));
      if (value !== undefined) risks[key] = value;
    }
    const mechanical = confidentAnswer(noulOf(answers, TRIAGE_QUESTION_IDS.mechanical));
    const reach = scoreOf(answers, TRIAGE_QUESTION_IDS.reach);
    const reachLevel = reach && reach.confidence >= TRIAGE_REACH_CONFIDENCE
      ? Math.min(3, Math.max(0, Math.round(reach.score)))
      : undefined;
    const disposition = actingDisposition(answers);
    if (
      disposition.disposition === null
      && Object.keys(risks).length === 0
      && mechanical === undefined
      && reachLevel === undefined
    ) {
      return abstain("nothing was judged confidently");
    }
    return act({
      ...disposition,
      candidates: triageCandidateAnswers(answers),
      risks,
      ...(mechanical === undefined ? {} : { mechanical }),
      ...(reachLevel === undefined ? {} : { reach: reachLevel }),
    });
  },
});
