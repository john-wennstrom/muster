import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileTaskDag } from "../../src/execution/delegation-dag.ts";
import { runScheduler } from "../../src/execution/scheduler.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import {
  beginDebugging,
  createDebuggingState,
  persistDebuggingState,
  recordUnexpectedFailure,
} from "../../src/policies/debugging.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("systematic debugging policy", () => {
  test("activates at the configured threshold and preserves the hypothesis trail", async () => {
    let state = createDebuggingState({
      runId: "run-1",
      taskId: "10.2",
      threshold: 2,
      createdAt: "2026-09-12T12:00:00.000Z",
    });
    state = recordUnexpectedFailure(state, {
      reproduction: "bun test tests/policies/debugging.test.ts",
      evidence: ["Expected pass, received exit code 1"],
      recordedAt: "2026-09-12T12:01:00.000Z",
    });
    expect(state.mode).toBe("ordinary_repair");
    state = recordUnexpectedFailure(state, {
      reproduction: "bun test tests/policies/debugging.test.ts",
      evidence: ["Same assertion failed after the first repair"],
      recordedAt: "2026-09-12T12:02:00.000Z",
    });
    expect(state.mode).toBe("systematic_debugging");
    expect(state.failures).toHaveLength(2);

    const debugging = beginDebugging(state, {
      rootCauseHypothesis: "The scheduler retries without changing terminal state",
      discriminatingCheck: "Assert the outcome after exactly two failed attempts",
      minimalFix: "Return the debugging outcome when the retry bound is exhausted",
      regressionVerification: "bun test tests/policies/debugging.test.ts",
      regressionExitCode: 0,
      recordedAt: "2026-09-12T12:03:00.000Z",
    });
    expect(debugging.investigation).toMatchObject({
      rootCauseHypothesis: "The scheduler retries without changing terminal state",
      regressionExitCode: 0,
    });

    const root = await mkdtemp(resolve(tmpdir(), "muster-debugging-"));
    temporaryDirectories.push(root);
    const store = new AtomicJsonStore(root);
    await persistDebuggingState(store, debugging);
    expect(await store.read("run-1", "debugging/10.2.json")).toEqual(debugging);
  });

  test("rejects investigation before the threshold and incomplete evidence", () => {
    const state = createDebuggingState({
      runId: "run-1",
      taskId: "10.2",
      threshold: 2,
      createdAt: "2026-09-12T12:00:00.000Z",
    });
    expect(() => beginDebugging(state, {
      rootCauseHypothesis: "Unknown",
      discriminatingCheck: "Run one check",
      minimalFix: "Change one line",
      regressionVerification: "bun test",
      regressionExitCode: 0,
      recordedAt: "2026-09-12T12:01:00.000Z",
    })).toThrow(expect.objectContaining({ code: "DEBUGGING_STATE_INVALID" }));
  });

  test("scheduler stops ordinary repairs at the threshold", async () => {
    const dag = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
      { id: "1.2", dependsOn: ["1.1"], checked: false },
    ], "a".repeat(64), "2026-09-12T12:00:00.000Z");
    const failures: string[] = [];
    const result = await runScheduler({
      dag,
      tasks: {
        "1.1": { mode: "write", maxAttempts: 2 },
        "1.2": { mode: "read", maxAttempts: 1 },
      },
      onUnexpectedFailure: (taskId, attempt, error) => {
        failures.push(`${taskId}:${attempt}:${error}`);
      },
      execute: async () => ({ outcome: "failed", error: "still failing" }),
    });

    expect(result.attempts["1.1"]).toBe(2);
    expect(result.states).toEqual({ "1.1": "debugging", "1.2": "blocked" });
    expect(failures).toEqual([
      "1.1:1:still failing",
      "1.1:2:still failing",
    ]);
  });
});