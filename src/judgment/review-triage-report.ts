import type { DecisionRecord } from "./audit.ts";
import { reviewTriageDecision } from "./gates.ts";

/**
 * How often review triage would have carried an approval forward, and how often the full review
 * that ran instead did not approve, read from `review.triage` records. This is what the rollout
 * gate is read off: shadow records supply both, and enforce is worth enabling only if false
 * skips are essentially absent. Pure, so the calibration script and any report share it.
 *
 * Every record is an edit that was eligible and was sent for judgment. A record is a would-have-
 * carried edit when the gate would have acted, whether or not the mode handed that outcome back.
 * A false skip is a would-have-carried edit followed by a review that did not approve. Only
 * records reconciled with a review can be compared; a record for which no review completed, and
 * a carry-forward that was enforced and so had no review to compare with, are counted but left
 * out of the comparison rather than counted as agreeing.
 */

export interface ReviewTriageReport {
  readonly decisionVersion: number;
  /** Edits sent for judgment. */
  readonly eligible: number;
  /** Records where judgment was unavailable, which the gate never saw. */
  readonly unavailable: number;
  /** Records where the service answered. */
  readonly answered: number;
  /** Answered records where the gate abstained. */
  readonly abstained: number;
  /** Answered records where the gate would have carried the approval forward. */
  readonly wouldHaveCarried: number;
  /** Records where the approval really was carried forward, which is enforce mode only. */
  readonly carried: number;
  /** Would-have-carried records with no review to compare with. */
  readonly unreconciled: number;
  /** Would-have-carried records reconciled with a review's verdict. */
  readonly compared: number;
  /** Compared records followed by a review that approved. */
  readonly agreed: number;
  /** Compared records followed by a review that did not approve. */
  readonly falseSkips: number;
  /** False skips over compared; null when nothing was compared. */
  readonly falseSkipRate: number | null;
}

function summarize(decisionVersion: number, group: readonly DecisionRecord[]): ReviewTriageReport {
  const answered = group.filter((record) => record.status === "answered");
  const wouldHaveCarried = answered.filter((record) => record.wouldHaveActed);
  const compared = wouldHaveCarried.filter((record) => record.agreement !== null);
  const agreed = compared.filter((record) => record.agreement === true).length;
  return {
    decisionVersion,
    eligible: group.length,
    unavailable: group.length - answered.length,
    answered: answered.length,
    abstained: answered.length - wouldHaveCarried.length,
    wouldHaveCarried: wouldHaveCarried.length,
    carried: group.filter((record) => record.acted).length,
    unreconciled: wouldHaveCarried.length - compared.length,
    compared: compared.length,
    agreed,
    falseSkips: compared.length - agreed,
    falseSkipRate: compared.length === 0 ? null : (compared.length - agreed) / compared.length,
  };
}

export function summarizeReviewTriage(records: readonly DecisionRecord[]): readonly ReviewTriageReport[] {
  const byVersion = new Map<number, DecisionRecord[]>();
  for (const record of records) {
    if (record.decision !== reviewTriageDecision.id) continue;
    byVersion.set(record.decisionVersion, [...(byVersion.get(record.decisionVersion) ?? []), record]);
  }
  return [...byVersion.entries()]
    .sort(([left], [right]) => left - right)
    .map(([decisionVersion, group]) => summarize(decisionVersion, group));
}
