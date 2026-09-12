import type {
  CheckpointRecord,
  ReviewRecord,
  RunManifest,
  TaskResultRecord,
} from "../persistence/records.ts";
import { HarnessError } from "../shared/errors.ts";

export interface OpenSpecRecoveryState {
  changeName: string;
  artifactDigest: string;
  tasks: Readonly<Record<string, boolean>>;
}

export interface RepositoryRecoveryState {
  repositoryId: string;
  commonDirectory: string;
  worktree: string;
  worktreeExists: boolean;
  head: string;
  indexDigest: string;
  diffDigest: string;
  sourceDigest: string;
}

export interface ChildRecoveryState {
  status: "running" | "exited";
  processId: number;
  runId: string;
  taskId: string;
}

export interface LeaseRecoveryState {
  status: "live" | "stale";
  processId: number;
  runId: string;
  taskId: string;
  repositoryId: string;
  worktree: string;
}

export interface RecoveryInput {
  openSpec: OpenSpecRecoveryState;
  repository: RepositoryRecoveryState;
  manifest: RunManifest;
  taskResults: readonly TaskResultRecord[];
  reviews: readonly ReviewRecord[];
  checkpoints: readonly CheckpointRecord[];
  child: ChildRecoveryState | null;
  lease: LeaseRecoveryState | null;
}

export type RecoveryAction =
  | { type: "release_stale_lease"; taskId: string; processId: number }
  | { type: "restore_checkpoint"; taskId: string; checkpointId: string }
  | { type: "wait_for_child"; taskId: string; processId: number }
  | { type: "wait_for_live_lease"; taskId: string; processId: number }
  | { type: "review_existing_changes"; taskId: string; sourceDigest: string }
  | { type: "resume_task_review"; taskId: string; sourceDigest: string }
  | { type: "synchronize_task_completion"; taskId: string; sourceDigest: string }
  | { type: "synchronize_runtime_completion"; taskId: string }
  | { type: "rerun_builder"; taskId: string }
  | { type: "resume_final_verification" }
  | { type: "invalidate_run"; reason: "artifact_digest_changed" };

export interface RecoveryPlan {
  actions: RecoveryAction[];
  discrepancies: string[];
}

function conflict(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("RECOVERY_STATE_CONFLICT", message, details);
}

function assertIdentity(input: RecoveryInput): void {
  const { manifest, openSpec, repository } = input;
  if (manifest.changeName !== openSpec.changeName) {
    conflict("Run manifest and OpenSpec describe different changes", {
      manifestChange: manifest.changeName,
      openSpecChange: openSpec.changeName,
    });
  }
  if (!repository.worktreeExists) {
    conflict("The recorded recovery worktree does not exist", {
      runId: manifest.runId,
      worktree: repository.worktree,
    });
  }
  if (
    manifest.repository.id !== repository.repositoryId ||
    manifest.repository.commonDirectory !== repository.commonDirectory ||
    manifest.worktree.path !== repository.worktree
  ) {
    conflict("Repository or worktree identity does not match the run manifest", {
      runId: manifest.runId,
      manifestRepository: manifest.repository,
      manifestWorktree: manifest.worktree.path,
      observedRepository: {
        id: repository.repositoryId,
        commonDirectory: repository.commonDirectory,
      },
      observedWorktree: repository.worktree,
    });
  }
}

function assertEvidenceIdentity(input: RecoveryInput): void {
  const taskIds = new Set(Object.keys(input.manifest.tasks));
  for (const result of input.taskResults) {
    if (result.runId !== input.manifest.runId || !taskIds.has(result.taskId)) {
      conflict("Task result evidence does not belong to this run", {
        runId: input.manifest.runId,
        evidenceRunId: result.runId,
        taskId: result.taskId,
      });
    }
  }
  for (const review of input.reviews) {
    if (review.runId !== input.manifest.runId) {
      conflict("Review evidence does not belong to this run", {
        runId: input.manifest.runId,
        evidenceRunId: review.runId,
      });
    }
    if (review.kind === "task" && !taskIds.has(review.taskId)) {
      conflict("Task review evidence references an unknown task", {
        runId: input.manifest.runId,
        taskId: review.taskId,
      });
    }
  }
}

function pendingCheckpoints(input: RecoveryInput): CheckpointRecord[] {
  const byId = new Map(input.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  return input.manifest.checkpoints.map((checkpointId) => {
    const checkpoint = byId.get(checkpointId);
    if (!checkpoint) {
      return conflict("Run manifest references missing checkpoint evidence", {
        runId: input.manifest.runId,
        checkpointId,
      });
    }
    if (
      checkpoint.runId !== input.manifest.runId ||
      checkpoint.changeName !== input.manifest.changeName ||
      !(checkpoint.taskId in input.manifest.tasks)
    ) {
      return conflict("Checkpoint evidence does not belong to this run", {
        runId: input.manifest.runId,
        checkpointId,
      });
    }
    return checkpoint;
  }).filter((checkpoint) => checkpoint.status === "pending");
}

function validateLease(input: RecoveryInput): void {
  if (!input.lease) return;
  const { lease, manifest, repository } = input;
  if (
    lease.runId !== manifest.runId ||
    lease.repositoryId !== repository.repositoryId ||
    lease.worktree !== repository.worktree ||
    !(lease.taskId in manifest.tasks)
  ) {
    conflict("Writer lease identity does not match the recovery run", {
      runId: manifest.runId,
      lease,
    });
  }
  if (manifest.writer && (
    manifest.writer.processId !== lease.processId ||
    manifest.writer.runId !== lease.runId ||
    manifest.writer.taskId !== lease.taskId
  )) {
    conflict("Observed writer lease conflicts with manifest ownership", {
      runId: manifest.runId,
      manifestWriter: manifest.writer,
      lease,
    });
  }
}

function hasChangedSource(input: RecoveryInput): boolean {
  return input.repository.head !== input.manifest.worktree.head ||
    input.repository.indexDigest !== input.manifest.worktree.indexDigest ||
    input.repository.diffDigest !== input.manifest.worktree.diffDigest;
}

function sourceOwner(input: RecoveryInput): string | undefined {
  const candidates = new Set<string>();
  if (input.manifest.writer) candidates.add(input.manifest.writer.taskId);
  if (input.child) candidates.add(input.child.taskId);
  if (input.lease) candidates.add(input.lease.taskId);
  for (const result of input.taskResults) {
    if (result.sourceDigest === input.repository.sourceDigest) candidates.add(result.taskId);
  }
  for (const [taskId, state] of Object.entries(input.manifest.tasks)) {
    if (state === "running") candidates.add(taskId);
  }
  if (candidates.size > 1) {
    conflict("Changed source has ambiguous task ownership", {
      runId: input.manifest.runId,
      taskIds: [...candidates].sort(),
    });
  }
  return candidates.values().next().value;
}

function latestMatchingResult(
  input: RecoveryInput,
  taskId: string,
): TaskResultRecord | undefined {
  return input.taskResults
    .filter((result) =>
      result.taskId === taskId &&
      result.outcome === "completed" &&
      result.sourceDigest === input.repository.sourceDigest
    )
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
}

function hasAcceptedReview(input: RecoveryInput, taskId: string): boolean {
  return input.reviews.some((review) =>
    review.kind === "task" &&
    review.taskId === taskId &&
    review.verdict === "APPROVE" &&
    review.artifactDigest === input.repository.sourceDigest
  );
}

export function planRecovery(input: RecoveryInput): RecoveryPlan {
  assertIdentity(input);
  assertEvidenceIdentity(input);
  validateLease(input);

  if (input.manifest.artifactDigest !== input.openSpec.artifactDigest) {
    return {
      actions: [{ type: "invalidate_run", reason: "artifact_digest_changed" }],
      discrepancies: ["OpenSpec artifacts changed after the run snapshot"],
    };
  }

  const checkpoints = pendingCheckpoints(input);
  if (checkpoints.length > 0) {
    return {
      actions: checkpoints.map((checkpoint) => ({
        type: "restore_checkpoint" as const,
        taskId: checkpoint.taskId,
        checkpointId: checkpoint.id,
      })),
      discrepancies: [],
    };
  }

  const actions: RecoveryAction[] = [];
  const discrepancies: string[] = [];
  const sourceChanged = hasChangedSource(input);
  const changedSourceOwner = sourceChanged ? sourceOwner(input) : undefined;
  if (sourceChanged && !changedSourceOwner) {
    conflict("Changed source has no recoverable task owner", {
      runId: input.manifest.runId,
      sourceDigest: input.repository.sourceDigest,
    });
  }
  if (input.lease?.status === "stale") {
    actions.push({
      type: "release_stale_lease",
      taskId: input.lease.taskId,
      processId: input.lease.processId,
    });
  }

  const taskIds = Object.keys(input.manifest.tasks).sort();
  for (const taskId of taskIds) {
    const openSpecDone = input.openSpec.tasks[taskId];
    if (openSpecDone === undefined) {
      conflict("Run manifest task is absent from current OpenSpec state", {
        runId: input.manifest.runId,
        taskId,
      });
    }

    const runtimeState = input.manifest.tasks[taskId];
    if (openSpecDone) {
      if (runtimeState !== "completed") {
        actions.push({ type: "synchronize_runtime_completion", taskId });
        discrepancies.push(`OpenSpec task ${taskId} is complete while runtime state is ${runtimeState}`);
      }
      continue;
    }

    const result = latestMatchingResult(input, taskId);
    if (result && hasAcceptedReview(input, taskId)) {
      actions.push({
        type: "synchronize_task_completion",
        taskId,
        sourceDigest: result.sourceDigest,
      });
      continue;
    }

    if (runtimeState === "completed") {
      conflict("Runtime claims task completion without matching accepted evidence", {
        runId: input.manifest.runId,
        taskId,
        sourceDigest: input.repository.sourceDigest,
      });
    }

    if (input.child?.status === "running" && input.child.taskId === taskId) {
      if (
        input.child.runId !== input.manifest.runId ||
        input.lease?.status !== "live" ||
        input.lease.processId !== input.child.processId ||
        input.lease.taskId !== taskId
      ) {
        conflict("A running child has no matching live writer lease", {
          runId: input.manifest.runId,
          taskId,
          child: input.child,
          lease: input.lease,
        });
      }
      actions.push({ type: "wait_for_child", taskId, processId: input.child.processId });
      continue;
    }

    if (input.lease?.status === "live" && input.lease.taskId === taskId) {
      actions.push({ type: "wait_for_live_lease", taskId, processId: input.lease.processId });
      continue;
    }

    if (sourceChanged) {
      if (taskId !== changedSourceOwner) continue;
      actions.push(result
        ? { type: "resume_task_review", taskId, sourceDigest: input.repository.sourceDigest }
        : { type: "review_existing_changes", taskId, sourceDigest: input.repository.sourceDigest });
      continue;
    }

    if (runtimeState === "ready" || runtimeState === "running") {
      actions.push({ type: "rerun_builder", taskId });
    }
  }

  if (taskIds.every((taskId) => input.openSpec.tasks[taskId]) && actions.length === 0) {
    actions.push({ type: "resume_final_verification" });
  }

  return { actions, discrepancies };
}