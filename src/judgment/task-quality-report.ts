import type { DecisionRecord } from "./audit.ts";
import { TASK_QUALITY_OUTCOME_PREFIX, planningTaskQualityDecision } from "./gates.ts";
import { TASK_QUALITY_KINDS, type TaskQualityKind } from "./questions.ts";

/**
 * Non-completion rates for tasks that plan-time assessment flagged against tasks it did not,
 * for each kind of finding, read from `planning.task_quality` records. This is what the rollout
 * gate is read off: enforce is worth enabling only if flagged tasks fail to complete on their
 * first attempt materially more often than unflagged ones. Pure, so the calibration script and
 * any report share it.
 *
 * A task counts only once its outcome is reconciled onto its record; a task that never ran, or
 * one whose reconciliation failed, is left out of both groups rather than counted as completed.
 * A whole-list coverage finding flags every reconciled task of its record, because it says the
 * list as a whole is deficient. Shadow and enforce records both count: the finding is judged the
 * same either way, and only enforce mode shows it to anyone.
 */

export interface TaskQualityGroupReport {
  /** Reconciled tasks in the group. */
  readonly tasks: number;
  /** Of those, the tasks whose first attempt did not complete. */
  readonly notCompleted: number;
  /** Null when the group is empty. */
  readonly nonCompletionRate: number | null;
}

export interface TaskQualityKindReport {
  readonly kind: TaskQualityKind;
  readonly flagged: TaskQualityGroupReport;
  readonly unflagged: TaskQualityGroupReport;
}

export interface TaskQualityReport {
  readonly decisionVersion: number;
  /** Every kind, in a fixed order, including kinds that never produced a finding. */
  readonly kinds: readonly TaskQualityKindReport[];
}

interface ReconciledTask {
  readonly completed: boolean;
  readonly flagged: ReadonlySet<TaskQualityKind>;
}

function reconciledTasks(record: DecisionRecord): ReconciledTask[] {
  const tasks: ReconciledTask[] = [];
  for (const [key, value] of Object.entries(record.observed)) {
    if (!key.startsWith(TASK_QUALITY_OUTCOME_PREFIX)) continue;
    const { status, flagged } = (value ?? {}) as { status?: unknown; flagged?: unknown };
    if (typeof status !== "string" || !Array.isArray(flagged)) continue;
    tasks.push({
      completed: status === "completed",
      flagged: new Set(flagged.filter((kind): kind is TaskQualityKind =>
        (TASK_QUALITY_KINDS as readonly unknown[]).includes(kind))),
    });
  }
  return tasks;
}

function group(tasks: readonly ReconciledTask[]): TaskQualityGroupReport {
  const notCompleted = tasks.filter((task) => !task.completed).length;
  return {
    tasks: tasks.length,
    notCompleted,
    nonCompletionRate: tasks.length === 0 ? null : notCompleted / tasks.length,
  };
}

export function summarizeTaskQuality(records: readonly DecisionRecord[]): readonly TaskQualityReport[] {
  const byVersion = new Map<number, ReconciledTask[]>();
  for (const record of records) {
    if (record.decision !== planningTaskQualityDecision.id || record.status !== "answered") continue;
    const tasks = reconciledTasks(record);
    if (tasks.length === 0) continue;
    byVersion.set(record.decisionVersion, [...(byVersion.get(record.decisionVersion) ?? []), ...tasks]);
  }
  return [...byVersion.entries()]
    .sort(([left], [right]) => left - right)
    .map(([decisionVersion, tasks]) => ({
      decisionVersion,
      kinds: TASK_QUALITY_KINDS.map((kind): TaskQualityKindReport => ({
        kind,
        flagged: group(tasks.filter((task) => task.flagged.has(kind))),
        unflagged: group(tasks.filter((task) => !task.flagged.has(kind))),
      })),
    }));
}
