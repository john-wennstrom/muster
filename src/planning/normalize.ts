import { posix } from "node:path";
import type { PlanTask, ProposalPlan } from "./plan-schema.ts";

const normalizedScope = (scope: string): string => posix.normalize(scope.replaceAll("\\", "/"));
const writeSet = (task: PlanTask): Set<string> => new Set(task.writes.map(normalizedScope));
const isBuilder = (task: PlanTask): boolean => (task.role ?? "builder") === "builder" && !task.manual;

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** The values of every list, deduplicated, in first-seen order. */
function union<T>(key: (value: T) => string, ...lists: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const value of lists.flat()) {
    if (!seen.has(key(value))) {
      seen.add(key(value));
      merged.push(value);
    }
  }
  return merged;
}

/** B follows A alone, nothing else follows A, both are builders, and both write exactly the same files. */
function mergeable(first: PlanTask, second: PlanTask, tasks: readonly PlanTask[]): boolean {
  if (second.dependsOn.length !== 1 || second.dependsOn[0] !== first.id) return false;
  if (tasks.some((task) => task.id !== second.id && task.dependsOn.includes(first.id))) return false;
  if (!isBuilder(first) || !isBuilder(second)) return false;
  const writes = writeSet(first);
  return writes.size > 0 && sameSet(writes, writeSet(second));
}

/**
 * Merges chained tasks that write the same files into one, so a plan does not pay two builders
 * and two reviewers for work the second would only re-read. The merged task keeps the first
 * task's id, joins the descriptions, takes the union of reads, requirement and scenario
 * references and verification commands, and everything that depended on the second now depends
 * on the first. Repeats until nothing merges. Returns what merged, so the plan explains itself.
 */
export function normalizePlan(plan: ProposalPlan): { plan: ProposalPlan; notes: string[] } {
  let tasks = plan.tasks.map((task) => ({ ...task }));
  const notes: string[] = [];
  for (let merged = true; merged;) {
    merged = false;
    for (const second of tasks) {
      const first = tasks.find((candidate) => mergeable(candidate, second, tasks));
      if (!first) continue;
      const combined: PlanTask = {
        ...first,
        description: `${first.description} Then: ${second.description}`,
        reads: union((scope) => scope, first.reads, second.reads),
        requirements: union((reference) => `${reference.capability}: ${reference.name}`, first.requirements, second.requirements),
        scenarios: union((name) => name, first.scenarios, second.scenarios),
        verify: union((command) => command, first.verify, second.verify),
      };
      tasks = tasks
        .filter((task) => task.id !== second.id)
        .map((task) => task.id === first.id
          ? combined
          : task.dependsOn.includes(second.id)
            ? { ...task, dependsOn: union((id) => id, task.dependsOn.map((id) => (id === second.id ? first.id : id))) }
            : task);
      notes.push(`merged ${second.id} into ${first.id}: same write scope`);
      merged = true;
      break;
    }
  }
  return { plan: { ...plan, tasks }, notes };
}
