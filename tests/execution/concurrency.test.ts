import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileTaskDag } from "../../src/execution/delegation-dag.ts";
import {
  runChangeScheduler,
  type ChangeTaskExecutionContext,
} from "../../src/execution/scheduler.ts";
import type { ChangeWorktree } from "../../src/execution/worktree.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("change scheduler concurrency", () => {
  test("serializes ready writers while an independent reader overlaps", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-scheduler-"));
    temporaryDirectories.push(root);
    const worktree: ChangeWorktree = {
      repositoryId: "repository-1",
      commonDirectory: resolve(root, ".git"),
      path: root,
      branch: "muster/change",
      head: "a".repeat(40),
      reused: false,
    };
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
      { id: "1.2", dependsOn: [], checked: false },
      { id: "1.3", dependsOn: [], checked: false },
    ], "a".repeat(64), "2026-09-12T12:00:00.000Z");
    const writerTasks: string[] = [];
    let activeWriters = 0;
    let maximumWriters = 0;
    let readerActive = false;
    let readerOverlappedWriter = false;
    let releaseReader!: () => void;
    const readerGate = new Promise<void>((resolveReader) => { releaseReader = resolveReader; });
    let selected = 0;

    const result = await runChangeScheduler({
      runId: "run-1",
      dag,
      tasks: {
        "1.1": { mode: "write", maxAttempts: 1 },
        "1.2": { mode: "write", maxAttempts: 1 },
        "1.3": { mode: "read", maxAttempts: 1 },
      },
      worktree: {
        planningCwd: root,
        changeName: "change",
        worktreesRoot: resolve(root, "worktrees"),
      },
      selectWorktree: async () => {
        selected++;
        return worktree;
      },
      lease: { lockDirectory: resolve(root, "locks") },
      execute: async (task, _attempt, context: ChangeTaskExecutionContext) => {
        expect(context.worktree).toBe(worktree);
        if (task.mode === "read") {
          expect(context.writerLease).toBeNull();
          readerActive = true;
          await readerGate;
          readerActive = false;
          return { outcome: "completed" };
        }
        expect(context.writerLease?.record.taskId).toBe(task.id);
        writerTasks.push(task.id);
        activeWriters++;
        maximumWriters = Math.max(maximumWriters, activeWriters);
        readerOverlappedWriter ||= readerActive;
        activeWriters--;
        releaseReader();
        return { outcome: "completed" };
      },
    });

    expect(selected).toBe(1);
    expect(maximumWriters).toBe(1);
    expect(writerTasks).toEqual(["1.1", "1.2"]);
    expect(readerOverlappedWriter).toBeTrue();
    expect(result.worktree).toBe(worktree);
    expect(result.states).toEqual({
      "1.1": "completed",
      "1.2": "completed",
      "1.3": "completed",
    });
  });
});