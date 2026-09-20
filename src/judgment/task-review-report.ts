import type { DecisionRecord } from "./audit.ts";
import { reviewTaskFocusDecision } from "./gates.ts";

/**
 * Finding counts for reviews that received a focus list against reviews that did not, read
 * from `review.task_focus` records. This is what the rollout gate is read off: shadow records
 * supply the unfocused baseline and enforce records the focused group, and the gate holds when
 * finding counts hold or improve. Pure, so the calibration script and any report share it.
 *
 * A record counts only once it is reconciled with its review's outcome; a review that has not
 * finished, or one whose reconciliation failed, is left out of both groups rather than counted
 * as a review with no findings. A review received a focus list only when the gate acted in
 * enforce mode; every other reconciled review, including one where judgment was unavailable, is
 * unfocused.
 */

export interface TaskReviewGroupReport {
  /** Reconciled reviews in the group. */
  readonly reviews: number;
  /** Null when the group is empty. */
  readonly meanRequiredFindings: number | null;
  readonly meanRecommendations: number | null;
  /** Items the gate chose for these reviews; an unfocused shadow review still has the items it would have been given. */
  readonly focusItems: number;
  /** Of those, the items that named an area the reviewer raised a finding in. */
  readonly focusItemsNamingRaisedArea: number;
  /** Null when the group had no items. */
  readonly namedRaisedAreaShare: number | null;
}

export interface TaskReviewFocusReport {
  readonly decisionVersion: number;
  readonly focused: TaskReviewGroupReport;
  readonly unfocused: TaskReviewGroupReport;
}

interface Reconciled {
  readonly record: DecisionRecord;
  readonly requiredFindings: number;
  readonly recommendations: number;
  readonly items: number;
  readonly itemsRaised: number;
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

function reconciled(record: DecisionRecord): Reconciled | null {
  const { requiredFindings, recommendations, focusItemsRaised } = record.observed;
  if (typeof requiredFindings !== "number" || typeof recommendations !== "number") return null;
  if (!Array.isArray(focusItemsRaised)) return null;
  const items = record.gate?.act
    ? ((record.gate.value as { items?: readonly unknown[] } | null)?.items?.length ?? 0)
    : 0;
  return { record, requiredFindings, recommendations, items, itemsRaised: focusItemsRaised.length };
}

function summarize(group: readonly Reconciled[]): TaskReviewGroupReport {
  const focusItems = group.reduce((sum, entry) => sum + entry.items, 0);
  const named = group.reduce((sum, entry) => sum + entry.itemsRaised, 0);
  return {
    reviews: group.length,
    meanRequiredFindings: mean(group.map((entry) => entry.requiredFindings)),
    meanRecommendations: mean(group.map((entry) => entry.recommendations)),
    focusItems,
    focusItemsNamingRaisedArea: named,
    namedRaisedAreaShare: focusItems === 0 ? null : named / focusItems,
  };
}

export function summarizeTaskReviewFocus(records: readonly DecisionRecord[]): readonly TaskReviewFocusReport[] {
  const byVersion = new Map<number, Reconciled[]>();
  for (const record of records) {
    if (record.decision !== reviewTaskFocusDecision.id) continue;
    const entry = reconciled(record);
    if (entry) byVersion.set(record.decisionVersion, [...(byVersion.get(record.decisionVersion) ?? []), entry]);
  }
  return [...byVersion.entries()]
    .sort(([left], [right]) => left - right)
    .map(([decisionVersion, group]) => ({
      decisionVersion,
      focused: summarize(group.filter((entry) => entry.record.acted)),
      unfocused: summarize(group.filter((entry) => !entry.record.acted)),
    }));
}
