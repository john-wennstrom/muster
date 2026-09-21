import type { ValidatedTask } from "./task-schema.ts";

export type CollaborationTaskMode = "read" | "write";

/** The task shape the child broker scopes its tools against. */
export interface CollaborationTask {
  id: string;
  assignee: string;
  description: string;
  depends_on: string[];
  outputs: string[];
  mode: CollaborationTaskMode;
  reads: string[];
  writes: string[];
}

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
