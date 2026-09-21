import type { TaskResultRecord } from "../persistence/records.ts";

/**
 * The verification commands whose passing evidence is still current, keyed by command to the
 * source digest they passed against. A task's commands are reused only all together: its
 * persisted result must record every one with exit code zero, and its recorded source digest must
 * equal the current one. A task with one command missing, failed or older than the source reuses
 * none, because a partial list says the task's own run did not finish its verification.
 */
export function reusableCommands(
  tasks: readonly { readonly id: string; readonly verify: readonly string[] }[],
  taskResults: readonly TaskResultRecord[],
  currentSourceDigest: string,
): ReadonlyMap<string, string> {
  const latest = new Map<string, TaskResultRecord>();
  for (const result of taskResults) {
    const known = latest.get(result.taskId);
    if (!known || result.completedAt.localeCompare(known.completedAt) > 0) latest.set(result.taskId, result);
  }
  const reusable = new Map<string, string>();
  for (const task of tasks) {
    const result = latest.get(task.id);
    if (!result || result.outcome !== "completed" || result.sourceDigest !== currentSourceDigest) continue;
    if (task.verify.length === 0) continue;
    // The pipeline records each command as "<command>: exit <code>".
    if (!task.verify.every((command) => result.verificationEvidence.includes(`${command}: exit 0`))) continue;
    for (const command of task.verify) reusable.set(command, result.sourceDigest);
  }
  return reusable;
}
