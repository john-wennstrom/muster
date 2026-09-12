import { isDeepStrictEqual } from "node:util";
import { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import {
  taskDagRecordSchema,
  type TaskDagRecord,
} from "../persistence/records.ts";
import { HarnessError } from "../shared/errors.ts";

export interface DagTaskInput {
  id: string;
  dependsOn: readonly string[];
  checked: boolean;
}

function invalidDag(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("TASK_DAG_INVALID", message, details);
}

function sortedUnique(values: readonly string[], taskId: string): string[] {
  const result = [...new Set(values)].sort();
  if (result.length !== values.length) {
    invalidDag("Task contains duplicate dependencies", { taskId, dependsOn: values });
  }
  return result;
}

function topologicalOrder(nodes: readonly TaskDagRecord["nodes"][number][]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const ordered: string[] = [];

  const visit = (taskId: string): void => {
    const currentState = state.get(taskId);
    if (currentState === "visited") return;
    if (currentState === "visiting") {
      const cycleStart = stack.indexOf(taskId);
      invalidDag("Task dependency graph contains a cycle", {
        cycle: [...stack.slice(cycleStart), taskId],
      });
    }
    state.set(taskId, "visiting");
    stack.push(taskId);
    const node = byId.get(taskId)!;
    for (const dependencyId of node.dependsOn) visit(dependencyId);
    stack.pop();
    state.set(taskId, "visited");
    ordered.push(taskId);
  };

  for (const node of nodes) visit(node.id);
  return ordered;
}

export function compileTaskDag(
  tasks: readonly DagTaskInput[],
  tasksDigest: string,
  createdAt: string,
  previous?: TaskDagRecord,
): TaskDagRecord {
  if (!/^[a-f0-9]{64}$/.test(tasksDigest)) {
    return invalidDag("Tasks digest must be a lowercase SHA-256 value", { tasksDigest });
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    return invalidDag("DAG creation timestamp is invalid", { createdAt });
  }

  const ids = new Set<string>();
  const nodes = [...tasks]
    .map((task) => {
      if (ids.has(task.id)) invalidDag("Task dependency graph contains a duplicate identifier", { taskId: task.id });
      ids.add(task.id);
      return {
        id: task.id,
        dependsOn: sortedUnique(task.dependsOn, task.id),
        checked: task.checked,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const node of nodes) {
    for (const dependencyId of node.dependsOn) {
      if (!ids.has(dependencyId)) {
        invalidDag("Task dependency references an unknown task", {
          taskId: node.id,
          dependencyId,
        });
      }
    }
  }
  if (previous) {
    for (const node of previous.nodes) {
      if (!node.checked && !ids.has(node.id)) {
        invalidDag("Previously incomplete task was removed from the task plan", {
          removedTaskId: node.id,
          previousTasksDigest: previous.tasksDigest,
          tasksDigest,
        });
      }
    }
  }

  return taskDagRecordSchema.parse({
    schemaVersion: 1,
    tasksDigest,
    createdAt,
    nodes,
    topologicalOrder: topologicalOrder(nodes),
  });
}

export function dependencyClosure(snapshot: TaskDagRecord, taskId: string): string[] {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  if (!byId.has(taskId)) return invalidDag("Cannot calculate closure for unknown task", { taskId });
  const closure = new Set<string>();
  const visit = (id: string): void => {
    for (const dependencyId of byId.get(id)!.dependsOn) {
      if (closure.has(dependencyId)) continue;
      closure.add(dependencyId);
      visit(dependencyId);
    }
  };
  visit(taskId);
  return snapshot.topologicalOrder.filter((id) => closure.has(id));
}

export async function persistTaskDag(
  store: AtomicJsonStore,
  runId: string,
  snapshot: TaskDagRecord,
): Promise<void> {
  const valid = taskDagRecordSchema.parse(snapshot);
  const recordPath = `dags/${valid.tasksDigest}.json`;
  try {
    const existing = taskDagRecordSchema.parse(
      await store.read<TaskDagRecord>(runId, recordPath),
    );
    if (!isDeepStrictEqual(existing, valid)) {
      throw new HarnessError(
        "TASK_DAG_IMMUTABLE",
        "A different DAG snapshot already exists for this tasks digest",
        { runId, tasksDigest: valid.tasksDigest, recordPath },
      );
    }
    return;
  } catch (error) {
    if (error instanceof HarnessError || !(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  await store.write(runId, recordPath, valid);
}