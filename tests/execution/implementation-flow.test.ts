import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileTaskDag } from "../../src/execution/delegation-dag.ts";
import { runImplementationFlow } from "../../src/execution/implementation-flow.ts";
import type { CheckpointRecord } from "../../src/persistence/records.ts";
import type { ChangeWorktree } from "../../src/execution/worktree.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-implementation-flow-"));
  temporaryDirectories.push(root);
  const worktree: ChangeWorktree = {
    repositoryId: "repo-1",
    commonDirectory: resolve(root, ".git"),
    path: root,
    branch: "muster/change",
    head: "a".repeat(40),
    reused: true,
  };
  return { root, worktree };
}

describe("implementation flow", () => {
  test("executes recovery before selecting a worktree and retries the task", async () => {
    const { root, worktree } = await fixture();
    const events: string[] = [];
    const dag = compileTaskDag([{ id: "1.1", dependsOn: [], checked: false }], "a".repeat(64), "2026-09-12T12:00:00.000Z");
    const result = await runImplementationFlow({
      reviewFreshness: "current",
      recovery: { actions: [{ type: "rerun_builder", taskId: "1.1" }], discrepancies: [] },
      executeRecoveryAction: async (action) => { events.push(`recover:${action.type}`); },
      scheduler: {
        runId: "run-1",
        dag,
        tasks: { "1.1": { mode: "write", maxAttempts: 2 } },
        worktree: { planningCwd: root, changeName: "change", worktreesRoot: resolve(root, "worktrees") },
        selectWorktree: async () => { events.push("worktree"); return worktree; },
        lease: { lockDirectory: resolve(root, "locks") },
        execute: async (_task, attempt) => {
          events.push(`attempt:${attempt}`);
          return attempt === 1 ? { outcome: "failed", error: "retry" } : { outcome: "completed" };
        },
      },
      onDesignConflict: async () => undefined,
    });

    expect(events).toEqual(["recover:rerun_builder", "worktree", "attempt:1", "attempt:2"]);
    expect(result.status).toBe("completed");
  });

  test("does not dispatch with stale review or artifact invalidation", async () => {
    const { root, worktree } = await fixture();
    let selected = false;
    const result = await runImplementationFlow({
      reviewFreshness: "stale",
      recovery: { actions: [{ type: "invalidate_run", reason: "artifact_digest_changed" }], discrepancies: [] },
      executeRecoveryAction: async () => undefined,
      scheduler: {
        runId: "run-1",
        dag: compileTaskDag([{ id: "1.1", dependsOn: [], checked: false }], "b".repeat(64), "2026-09-12T12:00:00.000Z"),
        tasks: { "1.1": { mode: "write", maxAttempts: 1 } },
        worktree: { planningCwd: root, changeName: "change", worktreesRoot: resolve(root, "worktrees") },
        selectWorktree: async () => { selected = true; return worktree; },
        execute: async () => ({ outcome: "completed" }),
      },
      onDesignConflict: async () => undefined,
    });
    expect(selected).toBeFalse();
    expect(result.status).toBe("review_required");
  });

  test("resumes confirmed branches and routes design conflicts to re-planning", async () => {
    const { root, worktree } = await fixture();
    const conflicts: string[][] = [];
    const checkpoint: CheckpointRecord = {
      schemaVersion: 1,
      id: "checkpoint-1",
      runId: "run-1",
      changeName: "change",
      taskId: "1.1",
      branch: ["1.1", "1.2"],
      category: "design_decision",
      reason: "Choose an API",
      instructions: ["Record the approved choice"],
      createdAt: "2026-09-12T12:00:00.000Z",
      status: "confirmed",
      resumeTarget: "1.1",
      confirmedAt: "2026-09-12T12:05:00.000Z",
      confirmedBy: "user",
    };
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
      { id: "1.2", dependsOn: ["1.1"], checked: false },
    ], "c".repeat(64), "2026-09-12T12:00:00.000Z");
    const result = await runImplementationFlow({
      reviewFreshness: "current",
      recovery: { actions: [], discrepancies: [] },
      executeRecoveryAction: async () => undefined,
      scheduler: {
        runId: "run-1",
        dag,
        tasks: {
          "1.1": { mode: "write", maxAttempts: 1 },
          "1.2": { mode: "write", maxAttempts: 1 },
        },
        pendingCheckpoints: [checkpoint],
        worktree: { planningCwd: root, changeName: "change", worktreesRoot: resolve(root, "worktrees") },
        selectWorktree: async () => worktree,
        lease: { lockDirectory: resolve(root, "locks") },
        execute: async (task) => ({ outcome: task.id === "1.1" ? "design_conflict" : "completed" }),
      },
      onDesignConflict: async (taskIds) => { conflicts.push([...taskIds]); },
    });

    expect(result.status).toBe("design_conflict");
    expect(conflicts).toEqual([["1.1"]]);
    expect(result.scheduler?.states).toEqual({ "1.1": "design_conflict", "1.2": "blocked" });
  });
});