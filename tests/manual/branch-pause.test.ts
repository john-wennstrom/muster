import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileTaskDag } from "../../src/execution/delegation-dag.ts";
import { runChangeScheduler } from "../../src/execution/scheduler.ts";
import type { CheckpointRecord } from "../../src/persistence/records.ts";
import type { ChangeWorktree } from "../../src/execution/worktree.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("manual checkpoint branch pauses", () => {
  test("stops the dependent closure while independent readers and writers continue", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-branch-pause-"));
    temporaryDirectories.push(root);
    const worktree: ChangeWorktree = {
      repositoryId: "repository-1",
      commonDirectory: resolve(root, ".git"),
      path: root,
      branch: "muster/change",
      head: "a".repeat(40),
      reused: true,
    };
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
      { id: "1.2", dependsOn: ["1.1"], checked: false },
      { id: "1.3", dependsOn: ["1.2"], checked: false },
      { id: "2.1", dependsOn: [], checked: false },
      { id: "2.2", dependsOn: [], checked: false },
    ], "a".repeat(64), "2026-09-12T12:00:00.000Z");
    const checkpoint: CheckpointRecord = {
      schemaVersion: 1,
      id: "checkpoint-1",
      runId: "run-1",
      changeName: "change",
      taskId: "1.1",
      branch: ["1.1", "1.2", "1.3"],
      category: "authentication",
      reason: "Authentication is required",
      instructions: ["Authenticate outside the agent channel"],
      createdAt: "2026-09-12T12:00:00.000Z",
      status: "pending",
      resumeTarget: "1.1",
    };
    const executed: string[] = [];

    const result = await runChangeScheduler({
      runId: "run-1",
      dag,
      tasks: {
        "1.1": { mode: "write", maxAttempts: 1 },
        "1.2": { mode: "write", maxAttempts: 1 },
        "1.3": { mode: "read", maxAttempts: 1 },
        "2.1": { mode: "write", maxAttempts: 1 },
        "2.2": { mode: "read", maxAttempts: 1 },
      },
      pendingCheckpoints: [checkpoint],
      worktree: {
        planningCwd: root,
        changeName: "change",
        worktreesRoot: resolve(root, "worktrees"),
      },
      selectWorktree: async () => worktree,
      lease: { lockDirectory: resolve(root, "locks") },
      execute: async (task, _attempt, context) => {
        executed.push(task.id);
        expect(context.writerLease === null).toBe(task.mode === "read");
        return { outcome: "completed" };
      },
    });

    expect(executed.sort()).toEqual(["2.1", "2.2"]);
    expect(result.states).toEqual({
      "1.1": "awaiting_user",
      "1.2": "blocked",
      "1.3": "blocked",
      "2.1": "completed",
      "2.2": "completed",
    });
  });

  test("releases a paused writer before running an independent writer", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-live-pause-"));
    temporaryDirectories.push(root);
    const worktree: ChangeWorktree = {
      repositoryId: "repository-1",
      commonDirectory: resolve(root, ".git"),
      path: root,
      branch: "muster/change",
      head: "a".repeat(40),
      reused: true,
    };
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
      { id: "1.2", dependsOn: ["1.1"], checked: false },
      { id: "2.1", dependsOn: [], checked: false },
    ], "b".repeat(64), "2026-09-12T12:00:00.000Z");
    const executed: string[] = [];

    const result = await runChangeScheduler({
      runId: "run-1",
      dag,
      tasks: {
        "1.1": { mode: "write", maxAttempts: 1 },
        "1.2": { mode: "write", maxAttempts: 1 },
        "2.1": { mode: "write", maxAttempts: 1 },
      },
      worktree: {
        planningCwd: root,
        changeName: "change",
        worktreesRoot: resolve(root, "worktrees"),
      },
      selectWorktree: async () => worktree,
      lease: { lockDirectory: resolve(root, "locks") },
      execute: async (task, _attempt, context) => {
        expect(context.writerLease?.record.taskId).toBe(task.id);
        executed.push(task.id);
        return { outcome: task.id === "1.1" ? "awaiting_user" : "completed" };
      },
    });

    expect(executed).toEqual(["1.1", "2.1"]);
    expect(result.states).toMatchObject({
      "1.1": "awaiting_user",
      "1.2": "blocked",
      "2.1": "completed",
    });
  });
});