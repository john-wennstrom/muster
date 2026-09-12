import { describe, expect, test } from "bun:test";
import { compileTaskDag } from "../../src/execution/delegation-dag.ts";
import { runScheduler } from "../../src/execution/scheduler.ts";

const digest = "a".repeat(64);
const createdAt = "2026-09-12T12:00:00.000Z";

describe("dependency scheduler", () => {
  test("overlaps independent reads and dispatches dependents afterward", async () => {
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
      { id: "1.2", dependsOn: [], checked: false },
      { id: "2.1", dependsOn: ["1.1", "1.2"], checked: false },
    ], digest, createdAt);
    let activeReads = 0;
    let maximumReads = 0;
    const dispatched: string[] = [];

    const result = await runScheduler({
      dag,
      tasks: {
        "1.1": { mode: "read", maxAttempts: 1 },
        "1.2": { mode: "read", maxAttempts: 1 },
        "2.1": { mode: "write", maxAttempts: 1 },
      },
      execute: async (task) => {
        dispatched.push(task.id);
        if (task.mode === "read") {
          activeReads++;
          maximumReads = Math.max(maximumReads, activeReads);
          await Promise.resolve();
          activeReads--;
        }
        return { outcome: "completed" };
      },
    });

    expect(maximumReads).toBe(2);
    expect(dispatched.indexOf("2.1")).toBeGreaterThan(dispatched.indexOf("1.1"));
    expect(dispatched.indexOf("2.1")).toBeGreaterThan(dispatched.indexOf("1.2"));
    expect(result.states).toEqual({ "1.1": "completed", "1.2": "completed", "2.1": "completed" });
  });

  test("serializes ready writers through queue hooks", async () => {
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
      { id: "1.2", dependsOn: [], checked: false },
    ], digest, createdAt);
    const events: string[] = [];
    let activeWriters = 0;
    let maximumWriters = 0;

    await runScheduler({
      dag,
      tasks: {
        "1.1": { mode: "write", maxAttempts: 1 },
        "1.2": { mode: "write", maxAttempts: 1 },
      },
      beforeWrite: async (taskId) => { events.push(`acquire:${taskId}`); },
      afterWrite: async (taskId) => { events.push(`release:${taskId}`); },
      execute: async (task) => {
        activeWriters++;
        maximumWriters = Math.max(maximumWriters, activeWriters);
        events.push(`run:${task.id}`);
        await Promise.resolve();
        activeWriters--;
        return { outcome: "completed" };
      },
    });

    expect(maximumWriters).toBe(1);
    expect(events).toEqual([
      "acquire:1.1", "run:1.1", "release:1.1",
      "acquire:1.2", "run:1.2", "release:1.2",
    ]);
  });

  test("retries within bounds and never dispatches dependents after failure", async () => {
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
      { id: "2.1", dependsOn: ["1.1"], checked: false },
    ], digest, createdAt);
    const attempts: string[] = [];

    const result = await runScheduler({
      dag,
      tasks: {
        "1.1": { mode: "write", maxAttempts: 2 },
        "2.1": { mode: "write", maxAttempts: 1 },
      },
      execute: async (task, attempt) => {
        attempts.push(`${task.id}:${attempt}`);
        return { outcome: "failed", error: "focused test failed" };
      },
    });

    expect(attempts).toEqual(["1.1:1", "1.1:2"]);
    expect(result.states).toEqual({ "1.1": "failed", "2.1": "blocked" });
  });

  test("cancellation prevents pending task dispatch", async () => {
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
    ], digest, createdAt);
    const controller = new AbortController();
    controller.abort();
    let dispatched = false;

    const result = await runScheduler({
      dag,
      tasks: { "1.1": { mode: "read", maxAttempts: 1 } },
      signal: controller.signal,
      execute: async () => {
        dispatched = true;
        return { outcome: "completed" };
      },
    });

    expect(dispatched).toBeFalse();
    expect(result.states).toEqual({ "1.1": "cancelled" });
  });
});