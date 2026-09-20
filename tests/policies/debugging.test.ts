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
  debuggingStateSchema,
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

  describe("failure state extensions", () => {
    const at = (minute: number) => `2026-09-12T12:${String(minute).padStart(2, "0")}:00.000Z`;
    const failure = (minute: number, attemptedFix?: string) => ({
      reproduction: "bun test",
      evidence: ["still failing"],
      ...(attemptedFix ? { attemptedFix } : {}),
      recordedAt: at(minute),
    });
    const withFailures = (threshold: number, count: number) => {
      let state = createDebuggingState({ runId: "run-1", taskId: "1.1", threshold, createdAt: at(0) });
      for (let index = 1; index <= count; index += 1) state = recordUnexpectedFailure(state, failure(index));
      return state;
    };
    const escalation = (attempt: number) => ({
      reason: "two consecutive rounds without progress",
      attempt,
      recordId: "decision-1",
      recordedAt: at(10),
    });

    test("a state written before the extensions validates and follows the count", () => {
      const legacy = {
        schemaVersion: 1 as const,
        runId: "run-1",
        taskId: "1.1",
        threshold: 2,
        mode: "systematic_debugging" as const,
        failures: [
          { attempt: 1, reproduction: "bun test", evidence: ["a"], recordedAt: at(1) },
          { attempt: 2, reproduction: "bun test", evidence: ["b"], recordedAt: at(2) },
        ],
        createdAt: at(0),
        updatedAt: at(2),
      };
      expect(debuggingStateSchema.parse(legacy)).toEqual(legacy);
      expect(withFailures(3, 2).mode).toBe("ordinary_repair");
      expect(withFailures(3, 3).mode).toBe("systematic_debugging");
    });

    test("an attempted fix is kept on the failure", () => {
      const state = recordUnexpectedFailure(withFailures(4, 1), failure(2, "Reordered the parser"));
      expect(state.failures[1]?.attemptedFix).toBe("Reordered the parser");
    });

    test("an early escalation at the latest failure below the threshold is valid", () => {
      const state = withFailures(5, 3);
      const escalated = debuggingStateSchema.parse({ ...state, mode: "systematic_debugging", escalation: escalation(3) });
      expect(escalated.mode).toBe("systematic_debugging");
      expect(() => recordUnexpectedFailure(escalated, failure(4))).toThrow(
        expect.objectContaining({ code: "DEBUGGING_STATE_INVALID" }),
      );
    });

    test("an escalation at or above the threshold is rejected", () => {
      const state = withFailures(3, 3);
      expect(() => debuggingStateSchema.parse({ ...state, escalation: escalation(3) })).toThrow();
      expect(() => debuggingStateSchema.parse({ ...state, escalation: escalation(4) })).toThrow();
    });

    test("an escalation must sit at the latest failure and in systematic mode", () => {
      const state = withFailures(5, 3);
      expect(() => debuggingStateSchema.parse({ ...state, mode: "systematic_debugging", escalation: escalation(2) })).toThrow();
      expect(() => debuggingStateSchema.parse({ ...state, escalation: escalation(3) })).toThrow();
    });

    test("systematic mode without an escalation below the threshold is rejected", () => {
      expect(() => debuggingStateSchema.parse({ ...withFailures(5, 3), mode: "systematic_debugging" })).toThrow();
    });

    test("assessments must follow recorded failures in increasing order", () => {
      const state = withFailures(5, 3);
      const assessment = (attempt: number) => ({
        attempt, sameRootCause: 0.9, progress: 0.1, humanNeeded: 0.1, recordId: null, recordedAt: at(attempt),
      });
      expect(debuggingStateSchema.parse({ ...state, assessments: [assessment(2), assessment(3)] }).assessments).toHaveLength(2);
      expect(() => debuggingStateSchema.parse({ ...state, assessments: [assessment(3), assessment(2)] })).toThrow();
      expect(() => debuggingStateSchema.parse({ ...state, assessments: [assessment(4)] })).toThrow();
    });
  });
});
