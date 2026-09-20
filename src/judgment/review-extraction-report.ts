import type { DecisionRecord } from "./audit.ts";
import { reviewExtractionDecision } from "./gates.ts";

/**
 * How often review extraction would have been accepted, and how often its verdict agreed with
 * the corrective retry's, read from `review.extraction` records. This is what the rollout gate
 * is read off: shadow records supply both rates, and enforce is used only once agreement holds.
 * Pure, so the calibration script and any report share it.
 *
 * Acceptance is over every record where the service answered, because those are the extractions
 * the gate judged. Agreement is over the records that could be compared, which are those the
 * gate would have accepted and whose retry then produced a review. A record for which no retry
 * ran to completion, or which was accepted in enforce mode and so never had a retry to compare
 * with, is counted as accepted but is left out of agreement rather than counted as a
 * disagreement.
 */

export interface ReviewExtractionReport {
  readonly decisionVersion: number;
  /** Records where judgment was unavailable, which the gate never saw. */
  readonly unavailable: number;
  /** Records where the service answered. */
  readonly answered: number;
  /** Answered records whose gate would have accepted the extraction. */
  readonly wouldHaveAccepted: number;
  /** Accepted answered records over answered records; null when nothing was answered. */
  readonly acceptanceRate: number | null;
  /** Records where the extraction replaced the retry, which is enforce mode only. */
  readonly acted: number;
  /** Accepted records with no retry result to compare with. */
  readonly unreconciled: number;
  /** Accepted records reconciled with a retry's verdict. */
  readonly compared: number;
  readonly agreed: number;
  /** Agreed over compared; null when nothing was compared. */
  readonly agreementRate: number | null;
}

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

function summarize(decisionVersion: number, group: readonly DecisionRecord[]): ReviewExtractionReport {
  const answered = group.filter((record) => record.status === "answered");
  const accepted = answered.filter((record) => record.wouldHaveActed);
  const compared = accepted.filter((record) => record.agreement !== null);
  const agreed = compared.filter((record) => record.agreement === true).length;
  return {
    decisionVersion,
    unavailable: group.length - answered.length,
    answered: answered.length,
    wouldHaveAccepted: accepted.length,
    acceptanceRate: rate(accepted.length, answered.length),
    acted: group.filter((record) => record.acted).length,
    unreconciled: accepted.length - compared.length,
    compared: compared.length,
    agreed,
    agreementRate: rate(agreed, compared.length),
  };
}

export function summarizeReviewExtraction(records: readonly DecisionRecord[]): readonly ReviewExtractionReport[] {
  const byVersion = new Map<number, DecisionRecord[]>();
  for (const record of records) {
    if (record.decision !== reviewExtractionDecision.id) continue;
    byVersion.set(record.decisionVersion, [...(byVersion.get(record.decisionVersion) ?? []), record]);
  }
  return [...byVersion.entries()]
    .sort(([left], [right]) => left - right)
    .map(([decisionVersion, group]) => summarize(decisionVersion, group));
}
