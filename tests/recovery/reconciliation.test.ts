import { describe, expect, test } from "bun:test";
import {
  planRecovery,
  type RecoveryInput,
} from "../../src/controller/recovery.ts";
import type {
  CheckpointRecord,
  ReviewRecord,
  RunManifest,
  TaskResultRecord,
} from "../../src/persistence/records.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const timestamp = "2026-09-12T12:00:00.000Z";

const manifest: RunManifest = {
  schemaVersion: 1,
  runId: "run-1",
  changeName: "add-search",
  lifecycle: "IMPLEMENTING",
  repository: { id: "repo-1", commonDirectory: "/repo/.git" },
  worktree: {
    path: "/repo-worktrees/add-search",
    head: "a".repeat(40),
    indexDigest: "index-before",
    diffDigest: "diff-before",
  },
  artifactDigest: "artifacts-current",
  tasks: { "1.1": "running" },
  modelAssignments: { builder: "openai/example" },
  writer: {
    processId: 42,
    runId: "run-1",
    taskId: "1.1",
    command: "builder",
    acquiredAt: timestamp,
  },
  checkpoints: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};

function input(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    openSpec: {
      changeName: "add-search",
      artifactDigest: "artifacts-current",
      tasks: { "1.1": false },
    },
    repository: {
      repositoryId: "repo-1",
      commonDirectory: "/repo/.git",
      worktree: "/repo-worktrees/add-search",
      worktreeExists: true,
      head: "a".repeat(40),
      indexDigest: "index-before",
      diffDigest: "diff-before",
      sourceDigest: "source-before",
    },
    manifest,
    taskResults: [],
    reviews: [],
    checkpoints: [],
    child: null,
    lease: null,
    ...overrides,
  };
}

describe("recovery reconciliation", () => {
  test("reviews existing source writes instead of rerunning the builder", () => {
    const recovery = planRecovery(input({
      repository: {
        ...input().repository,
        diffDigest: "diff-after-write",
        sourceDigest: "source-after-write",
      },
      lease: {
        status: "stale",
        processId: 42,
        runId: "run-1",
        taskId: "1.1",
        repositoryId: "repo-1",
        worktree: "/repo-worktrees/add-search",
      },
    }));

    expect(recovery.actions).toEqual([
      { type: "release_stale_lease", taskId: "1.1", processId: 42 },
      {
        type: "review_existing_changes",
        taskId: "1.1",
        sourceDigest: "source-after-write",
      },
    ]);
    expect(recovery.actions.some((action) => action.type === "rerun_builder")).toBeFalse();
  });

  test("attributes an existing diff only to the active writer task", () => {
    const recovery = planRecovery(input({
      openSpec: {
        changeName: "add-search",
        artifactDigest: "artifacts-current",
        tasks: { "1.1": false, "1.2": false },
      },
      repository: {
        ...input().repository,
        diffDigest: "diff-after-write",
        sourceDigest: "source-after-write",
      },
      manifest: {
        ...manifest,
        tasks: { "1.1": "running", "1.2": "ready" },
      },
    }));

    expect(recovery.actions).toEqual([
      {
        type: "review_existing_changes",
        taskId: "1.1",
        sourceDigest: "source-after-write",
      },
    ]);
  });

  test("synchronizes OpenSpec after matching task result and review evidence", () => {
    const taskResult: TaskResultRecord = {
      schemaVersion: 1,
      runId: "run-1",
      taskId: "1.1",
      outcome: "completed",
      sourceDigest: "source-after-write",
      verificationEvidence: ["bun test tests/recovery"],
      completedAt: timestamp,
    };
    const review: ReviewRecord = {
      schemaVersion: 1,
      runId: "run-1",
      taskId: "1.1",
      kind: "task",
      verdict: "APPROVE",
      artifactDigest: "source-after-write",
      model: "openai/reviewer",
      findings: [],
      createdAt: timestamp,
    };

    const recovery = planRecovery(input({
      repository: {
        ...input().repository,
        diffDigest: "diff-after-write",
        sourceDigest: "source-after-write",
      },
      manifest: { ...manifest, tasks: { "1.1": "completed" }, writer: null },
      taskResults: [taskResult],
      reviews: [review],
    }));

    expect(recovery.actions).toEqual([
      {
        type: "synchronize_task_completion",
        taskId: "1.1",
        sourceDigest: "source-after-write",
      },
    ]);
  });

  test("restores unresolved checkpoints before any task action", () => {
    const checkpoint: CheckpointRecord = {
      schemaVersion: 1,
      id: "checkpoint-1",
      runId: "run-1",
      changeName: "add-search",
      taskId: "1.1",
      branch: ["1.1"],
      category: "authentication",
      reason: "Authentication required",
      instructions: ["Authenticate outside the agent session"],
      createdAt: timestamp,
      status: "pending",
      resumeTarget: "1.1",
    };

    const recovery = planRecovery(input({
      manifest: {
        ...manifest,
        lifecycle: "AWAITING_USER",
        tasks: { "1.1": "awaiting_user" },
        writer: null,
        checkpoints: ["checkpoint-1"],
      },
      checkpoints: [checkpoint],
    }));

    expect(recovery.actions).toEqual([
      { type: "restore_checkpoint", taskId: "1.1", checkpointId: "checkpoint-1" },
    ]);
  });

  test("waits for a matching live child and writer lease", () => {
    const recovery = planRecovery(input({
      child: { status: "running", processId: 42, runId: "run-1", taskId: "1.1" },
      lease: {
        status: "live",
        processId: 42,
        runId: "run-1",
        taskId: "1.1",
        repositoryId: "repo-1",
        worktree: "/repo-worktrees/add-search",
      },
    }));

    expect(recovery.actions).toEqual([
      { type: "wait_for_child", taskId: "1.1", processId: 42 },
    ]);
  });

  test("fails closed when the recorded worktree identity is missing", () => {
    expect(() => planRecovery(input({
      repository: { ...input().repository, worktreeExists: false },
    }))).toThrow(expect.objectContaining({
      code: "RECOVERY_STATE_CONFLICT",
    }) as HarnessError);
  });
});