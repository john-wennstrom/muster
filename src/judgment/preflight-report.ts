import type { DecisionRecord } from "./audit.ts";
import { PREFLIGHT_CONFIDENCE_FLOOR, planningPreflightDecision } from "./gates.ts";
import { PREFLIGHT_QUESTION_IDS } from "./questions.ts";

/**
 * Agreement and precision for `planning.preflight`, read from its records. This is what the
 * rollout gate is read off: how often the judged disposition matches the agent's, and above all
 * how often a confident already-satisfied is one the agent also returned, because that is the
 * outcome that stops a user's request. Pure, so the calibration script and any report share it.
 *
 * Only shadow-mode records carry agreement: there the agent ran exactly as it does without
 * judgment. A record the agent never saw, or one where the agent had the candidates, is left out
 * of agreement and precision rather than counted as either.
 */

export interface PreflightReport {
  readonly decisionVersion: number;
  readonly calls: number;
  /** Calls that got answers, as opposed to being unavailable. */
  readonly answered: number;
  readonly wouldHaveActed: number;
  /** Would-have-acted over answered; null when nothing was answered. */
  readonly actionRate: number | null;
  /** Answered records reconciled with the agent's disposition. */
  readonly reconciled: number;
  readonly agreed: number;
  readonly agreementRate: number | null;
  readonly alreadySatisfied: {
    /** Reconciled records where already-satisfied was judged at or above the confidence floor. */
    readonly confident: number;
    /** Of those, the ones where the agent also returned already-satisfied. */
    readonly agentAgreed: number;
    /** Null when no confident already-satisfied has been reconciled. */
    readonly precision: number | null;
  };
  /** Records by which path produced the preflight; a record with no marker is not counted. */
  readonly byPath: { readonly judgment: number; readonly agent: number };
}

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

function judgedDisposition(record: DecisionRecord): { choice: string; confidence: number } | null {
  const answer = record.answers?.[PREFLIGHT_QUESTION_IDS.disposition];
  return answer?.type === "choice" ? { choice: answer.choice, confidence: answer.confidence } : null;
}

export function summarizePreflightAgreement(records: readonly DecisionRecord[]): readonly PreflightReport[] {
  const byVersion = new Map<number, DecisionRecord[]>();
  for (const record of records) {
    if (record.decision !== planningPreflightDecision.id) continue;
    byVersion.set(record.decisionVersion, [...(byVersion.get(record.decisionVersion) ?? []), record]);
  }
  return [...byVersion.entries()]
    .sort(([left], [right]) => left - right)
    .map(([decisionVersion, group]) => {
      const answered = group.filter((record) => record.status === "answered");
      const wouldHaveActed = answered.filter((record) => record.wouldHaveActed).length;
      const reconciled = answered.flatMap((record) => {
        const judged = judgedDisposition(record);
        const agent = record.observed.agentDisposition;
        return record.agreement !== null && judged && typeof agent === "string" ? [{ judged, agent }] : [];
      });
      const agreed = reconciled.filter(({ judged, agent }) => judged.choice === agent).length;
      const confident = reconciled.filter(({ judged }) =>
        judged.choice === "already_satisfied" && judged.confidence >= PREFLIGHT_CONFIDENCE_FLOOR);
      const agentAgreed = confident.filter(({ agent }) => agent === "already_satisfied").length;
      return {
        decisionVersion,
        calls: group.length,
        answered: answered.length,
        wouldHaveActed,
        actionRate: rate(wouldHaveActed, answered.length),
        reconciled: reconciled.length,
        agreed,
        agreementRate: rate(agreed, reconciled.length),
        alreadySatisfied: {
          confident: confident.length,
          agentAgreed,
          precision: rate(agentAgreed, confident.length),
        },
        byPath: {
          judgment: group.filter((record) => record.observed.producedBy === "judgment").length,
          agent: group.filter((record) => record.observed.producedBy === "agent").length,
        },
      };
    });
}
