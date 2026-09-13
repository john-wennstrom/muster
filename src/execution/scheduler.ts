import type { CheckpointRecord, TaskDagRecord } from "../persistence/records.ts";
import { HarnessError } from "../shared/errors.ts";
import {
  acquireWriterLease,
  type AcquireWriterLeaseOptions,
  type WriterLease,
  type WriterLeaseRecord,
} from "./writer-lease.ts";
import {
  ensureChangeWorktree,
  type ChangeWorktree,
  type EnsureChangeWorktreeOptions,
} from "./worktree.ts";

export type ScheduledTaskState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "awaiting_user"
  | "design_conflict"
  | "debugging"
  | "cancelled";

export interface ScheduledTask {
  id: string;
  mode: "read" | "write";
  maxAttempts: number;
}

export interface ScheduledTaskResult {
  outcome: Exclude<ScheduledTaskState, "pending" | "running">;
  error?: string;
}

export interface SchedulerOptions {
  dag: TaskDagRecord;
  tasks: Readonly<Record<string, Omit<ScheduledTask, "id">>>;
  pendingCheckpoints?: readonly CheckpointRecord[];
  execute: (
    task: ScheduledTask,
    attempt: number,
    signal?: AbortSignal,
  ) => Promise<ScheduledTaskResult>;
  beforeWrite?: (taskId: string) => Promise<void> | void;
  afterWrite?: (taskId: string) => Promise<void> | void;
  onUnexpectedFailure?: (
    taskId: string,
    attempt: number,
    error: string,
  ) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface SchedulerResult {
  states: Record<string, ScheduledTaskState>;
  attempts: Record<string, number>;
  errors: Record<string, string>;
}

export interface ChangeTaskExecutionContext {
  worktree: ChangeWorktree;
  writerLease: WriterLease | null;
}

export interface ChangeSchedulerOptions extends Omit<
  SchedulerOptions,
  "execute" | "beforeWrite" | "afterWrite"
> {
  runId: string;
  worktree: EnsureChangeWorktreeOptions;
  execute: (
    task: ScheduledTask,
    attempt: number,
    context: ChangeTaskExecutionContext,
    signal?: AbortSignal,
  ) => Promise<ScheduledTaskResult>;
  lease?: Pick<
    AcquireWriterLeaseOptions,
    "lockDirectory" | "processAlive" | "reconcileStaleOwner" | "now"
  >;
  selectWorktree?: typeof ensureChangeWorktree;
}

export interface ChangeSchedulerResult extends SchedulerResult {
  worktree: ChangeWorktree;
}

function invalid(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("TASK_SCHEDULER_INVALID", message, details);
}

function validateTasks(options: SchedulerOptions): Map<string, ScheduledTask> {
  const dagIds = new Set(options.dag.nodes.map((node) => node.id));
  for (const taskId of Object.keys(options.tasks)) {
    if (!dagIds.has(taskId)) invalid("Scheduler task is absent from the DAG", { taskId });
  }
  const tasks = new Map<string, ScheduledTask>();
  for (const node of options.dag.nodes) {
    const task = options.tasks[node.id];
    if (!node.checked && !task) invalid("Incomplete DAG task has no scheduler configuration", { taskId: node.id });
    if (!task) continue;
    if (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1) {
      invalid("Task maxAttempts must be a positive integer", {
        taskId: node.id,
        maxAttempts: task.maxAttempts,
      });
    }
    tasks.set(node.id, { id: node.id, ...task });
  }
  return tasks;
}

export function affectedTaskBranch(dag: TaskDagRecord, taskId: string): string[] {
  if (!dag.nodes.some((node) => node.id === taskId)) {
    return invalid("Manual checkpoint task is absent from the DAG", { taskId });
  }
  const affected = new Set([taskId]);
  for (const candidateId of dag.topologicalOrder) {
    const candidate = dag.nodes.find((node) => node.id === candidateId)!;
    if (candidate.dependsOn.some((dependencyId) => affected.has(dependencyId))) {
      affected.add(candidateId);
    }
  }
  return dag.topologicalOrder.filter((candidateId) => affected.has(candidateId));
}

function seedCheckpointPauses(
  options: SchedulerOptions,
  states: Record<string, ScheduledTaskState>,
): void {
  const checkpointIds = new Set<string>();
  for (const checkpoint of options.pendingCheckpoints ?? []) {
    if (checkpoint.status !== "pending") continue;
    if (checkpointIds.has(checkpoint.id)) {
      invalid("Scheduler received a duplicate manual checkpoint", { checkpointId: checkpoint.id });
    }
    checkpointIds.add(checkpoint.id);
    const expectedBranch = affectedTaskBranch(options.dag, checkpoint.taskId);
    if (
      checkpoint.branch.length !== expectedBranch.length ||
      checkpoint.branch.some((taskId, index) => taskId !== expectedBranch[index])
    ) {
      invalid("Manual checkpoint branch does not match the DAG dependent closure", {
        checkpointId: checkpoint.id,
        recordedBranch: checkpoint.branch,
        expectedBranch,
      });
    }
    if (states[checkpoint.taskId] === "completed") {
      invalid("Manual checkpoint references a completed task", {
        checkpointId: checkpoint.id,
        taskId: checkpoint.taskId,
      });
    }
    states[checkpoint.taskId] = "awaiting_user";
    for (const taskId of expectedBranch.slice(1)) states[taskId] = "blocked";
  }
}

export async function runScheduler(options: SchedulerOptions): Promise<SchedulerResult> {
  const tasks = validateTasks(options);
  const nodes = new Map(options.dag.nodes.map((node) => [node.id, node]));
  const states: Record<string, ScheduledTaskState> = {};
  const attempts: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const node of options.dag.nodes) {
    states[node.id] = node.checked ? "completed" : "pending";
    attempts[node.id] = 0;
  }
  seedCheckpointPauses(options, states);

  const active = new Map<string, Promise<{ taskId: string; result: ScheduledTaskResult }>>();

  const executeTask = async (task: ScheduledTask): Promise<ScheduledTaskResult> => {
    let result: ScheduledTaskResult = { outcome: "failed", error: "task did not execute" };
    let writerAcquired = false;
    try {
      if (task.mode === "write") {
        await options.beforeWrite?.(task.id);
        writerAcquired = true;
      }
      for (let attempt = 1; attempt <= task.maxAttempts; attempt++) {
        if (options.signal?.aborted) return { outcome: "cancelled" };
        attempts[task.id] = attempt;
        try {
          result = await options.execute(task, attempt, options.signal);
        } catch (error) {
          result = {
            outcome: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (options.signal?.aborted) return { outcome: "cancelled" };
        if (result.outcome !== "failed") return result;
        await options.onUnexpectedFailure?.(
          task.id,
          attempt,
          result.error ?? "task attempt failed without an error",
        );
      }
      return { outcome: "debugging", error: result.error };
    } finally {
      if (writerAcquired) await options.afterWrite?.(task.id);
    }
  };

  const launch = (task: ScheduledTask): void => {
    states[task.id] = "running";
    active.set(task.id, executeTask(task).then((result) => ({ taskId: task.id, result })));
  };

  while (true) {
    if (options.signal?.aborted) {
      for (const taskId of options.dag.topologicalOrder) {
        if (states[taskId] === "pending") states[taskId] = "cancelled";
      }
    }

    for (const taskId of options.dag.topologicalOrder) {
      if (states[taskId] !== "pending") continue;
      const dependencyStates = nodes.get(taskId)!.dependsOn.map((dependencyId) => states[dependencyId]);
      if (dependencyStates.some((state) =>
        state === "failed" ||
        state === "blocked" ||
        state === "awaiting_user" ||
        state === "design_conflict" ||
        state === "debugging" ||
        state === "cancelled"
      )) {
        states[taskId] = "blocked";
      }
    }

    const ready = options.dag.topologicalOrder
      .filter((taskId) =>
        states[taskId] === "pending" &&
        nodes.get(taskId)!.dependsOn.every((dependencyId) => states[dependencyId] === "completed")
      )
      .map((taskId) => tasks.get(taskId)!);
    if (!options.signal?.aborted) {
      for (const task of ready.filter((candidate) => candidate.mode === "read")) launch(task);
      const writerActive = [...active.keys()].some((taskId) => tasks.get(taskId)?.mode === "write");
      const nextWriter = ready.find((task) => task.mode === "write");
      if (!writerActive && nextWriter) launch(nextWriter);
    }

    if (active.size === 0) {
      const pending = options.dag.topologicalOrder.filter((taskId) => states[taskId] === "pending");
      if (pending.length > 0) invalid("Scheduler reached an unresolved dependency state", { pending, states });
      break;
    }

    const settled = await Promise.race(active.values());
    active.delete(settled.taskId);
    states[settled.taskId] = settled.result.outcome;
    if (settled.result.error) errors[settled.taskId] = settled.result.error;
  }

  return { states, attempts, errors };
}

export async function runChangeScheduler(
  options: ChangeSchedulerOptions,
): Promise<ChangeSchedulerResult> {
  const worktree = await (options.selectWorktree ?? ensureChangeWorktree)(options.worktree);
  const leases = new Map<string, WriterLease>();
  const scheduler = await runScheduler({
    dag: options.dag,
    tasks: options.tasks,
    pendingCheckpoints: options.pendingCheckpoints,
    onUnexpectedFailure: options.onUnexpectedFailure,
    signal: options.signal,
    beforeWrite: async (taskId) => {
      const lease = await acquireWriterLease({
        identity: {
          repositoryId: worktree.repositoryId,
          worktreePath: worktree.path,
          runId: options.runId,
          taskId,
          command: "builder",
        },
        ...options.lease,
      });
      leases.set(taskId, lease);
    },
    afterWrite: async (taskId) => {
      const lease = leases.get(taskId);
      leases.delete(taskId);
      await lease?.release();
    },
    execute: (task, attempt, signal) => options.execute(
      task,
      attempt,
      { worktree, writerLease: leases.get(task.id) ?? null },
      signal,
    ),
  });
  return { ...scheduler, worktree };
}