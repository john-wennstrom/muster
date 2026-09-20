import type { DecisionRecord } from "./audit.ts";
import { modelRoutingDecision, type TaskRoutingLane } from "./gates.ts";

/**
 * How often tasks completed on their first attempt, by the lane they ran on, read from
 * `routing.task_model` records. This is what the rollout gate is read off: shadow records give
 * the primary builder's rate for the tasks the gate would have routed, and enforce records give
 * the economy lane's rate to compare it with. Pure, so the calibration script and any report
 * share it.
 *
 * Each record is one task's first attempt. Only a record the implementation phase reconciled,
 * which holds the lane it ran on and the attempt's outcome, can be counted; the rest are shown
 * as unreconciled and left out of every rate rather than counted as failures or successes. A
 * task completed on its first attempt when that outcome is `completed`; a blocked task, a
 * design conflict, a wait for the user, and an attempt that threw all count against the lane.
 */

export interface LaneOutcome {
  /** Reconciled tasks. */
  readonly tasks: number;
  readonly completedFirstAttempt: number;
  /** Completed over tasks; null when no task was reconciled. */
  readonly rate: number | null;
}

export interface ModelRoutingReport {
  readonly decisionVersion: number;
  /** Tasks sent for judgment. */
  readonly decided: number;
  /** Records with no reconciled outcome, left out of every rate. */
  readonly unreconciled: number;
  readonly lanes: Readonly<Record<TaskRoutingLane, LaneOutcome>>;
  /**
   * Shadow-mode tasks the gate would have sent to the economy lane, which ran on the primary
   * builder: the baseline the economy lane's rate is compared with.
   */
  readonly wouldHaveRouted: LaneOutcome;
}

interface Reconciled {
  readonly lane: TaskRoutingLane;
  readonly completed: boolean;
  readonly record: DecisionRecord;
}

function outcomeOf(group: readonly Reconciled[]): LaneOutcome {
  const completedFirstAttempt = group.filter((entry) => entry.completed).length;
  return {
    tasks: group.length,
    completedFirstAttempt,
    rate: group.length === 0 ? null : completedFirstAttempt / group.length,
  };
}

function reconciled(record: DecisionRecord): Reconciled | null {
  const { lane, outcome } = record.observed;
  if ((lane !== "primary" && lane !== "economy") || typeof outcome !== "string") return null;
  return { lane, completed: outcome === "completed", record };
}

function summarize(decisionVersion: number, group: readonly DecisionRecord[]): ModelRoutingReport {
  const counted = group.flatMap((record) => reconciled(record) ?? []);
  return {
    decisionVersion,
    decided: group.length,
    unreconciled: group.length - counted.length,
    lanes: {
      primary: outcomeOf(counted.filter((entry) => entry.lane === "primary")),
      economy: outcomeOf(counted.filter((entry) => entry.lane === "economy")),
    },
    wouldHaveRouted: outcomeOf(counted.filter((entry) =>
      entry.record.mode === "shadow" && entry.record.status === "answered" && entry.record.wouldHaveActed)),
  };
}

export function summarizeModelRouting(records: readonly DecisionRecord[]): readonly ModelRoutingReport[] {
  const byVersion = new Map<number, DecisionRecord[]>();
  for (const record of records) {
    if (record.decision !== modelRoutingDecision.id) continue;
    byVersion.set(record.decisionVersion, [...(byVersion.get(record.decisionVersion) ?? []), record]);
  }
  return [...byVersion.entries()]
    .sort(([left], [right]) => left - right)
    .map(([decisionVersion, group]) => summarize(decisionVersion, group));
}
