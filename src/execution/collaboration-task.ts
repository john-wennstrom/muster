import type { CollaborationTask } from "../../extensions/fusion-harness/modules/collaboration-graph.ts";
import type { ValidatedTask } from "./task-schema.ts";

/** Adapts a validated task into the collaboration task shape the child broker scopes against. */
export function collaborationTask(task: ValidatedTask): CollaborationTask {
  return {
    id: task.id,
    assignee: task.role,
    description: task.description,
    depends_on: [...task.dependsOn],
    outputs: [],
    mode: task.writes.length > 0 ? "write" : "read",
    reads: [...task.reads],
    writes: [...task.writes],
  };
}
