import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { evaluateTaskOutcome } from "../../src/execution/task-runner.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import {
  createTddEvidence,
  createTddException,
  persistTddEvidence,
} from "../../src/policies/tdd.ts";

const temporaryDirectories: string[] = [];
const requirement = "policy-enforcement: Test-driven implementation policy";
const scenario = "Behavior task has no red-stage evidence";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function completion(tddEvidence?: ReturnType<typeof createTddEvidence> | ReturnType<typeof createTddException>) {
  return evaluateTaskOutcome({
    taskId: "10.1",
    claim: "completed",
    implementationPersisted: true,
    verificationPassed: true,
    taskReviewApproved: true,
    evidencePersisted: true,
    behaviorChanging: true,
    requirements: [requirement],
    scenarios: [scenario],
    tddEvidence,
  });
}

describe("TDD evidence policy", () => {
  test("blocks behavior-changing completion without red-stage evidence", () => {
    expect(completion()).toMatchObject({
      status: "blocked",
      synchronizeCheckbox: false,
      reason: "behavior-changing task has no TDD evidence",
    });
  });

  test("accepts and persists linked red, green, and refactor evidence", async () => {
    const evidence = createTddEvidence({
      runId: "run-1",
      taskId: "10.1",
      requirements: [requirement],
      scenarios: [scenario],
      red: {
        command: "bun test tests/policies/tdd.test.ts",
        exitCode: 1,
        recordedAt: "2026-09-12T12:00:00.000Z",
      },
      green: {
        command: "bun test tests/policies/tdd.test.ts",
        exitCode: 0,
        recordedAt: "2026-09-12T12:05:00.000Z",
      },
      refactor: [{
        command: "bun test tests/policies/tdd.test.ts",
        exitCode: 0,
        recordedAt: "2026-09-12T12:06:00.000Z",
      }],
      createdAt: "2026-09-12T12:06:00.000Z",
    });
    expect(completion(evidence)).toMatchObject({
      status: "completed",
      synchronizeCheckbox: true,
    });

    const root = await mkdtemp(resolve(tmpdir(), "muster-tdd-"));
    temporaryDirectories.push(root);
    const store = new AtomicJsonStore(root);
    await persistTddEvidence(store, evidence);
    expect(await store.read("run-1", "tdd/10.1.json")).toEqual(evidence);
  });

  test("rejects failed post-refactor checks and mismatched links", () => {
    const evidence = createTddEvidence({
      runId: "run-1",
      taskId: "10.1",
      requirements: [requirement],
      scenarios: [scenario],
      red: { command: "test", exitCode: 1, recordedAt: "2026-09-12T12:00:00.000Z" },
      green: { command: "test", exitCode: 0, recordedAt: "2026-09-12T12:01:00.000Z" },
      refactor: [{ command: "test", exitCode: 1, recordedAt: "2026-09-12T12:02:00.000Z" }],
      createdAt: "2026-09-12T12:02:00.000Z",
    });
    expect(completion(evidence)).toMatchObject({
      status: "blocked",
      reason: "post-refactor checks have not passed",
    });
    expect(evaluateTaskOutcome({
      taskId: "10.1",
      claim: "completed",
      implementationPersisted: true,
      verificationPassed: true,
      taskReviewApproved: true,
      evidencePersisted: true,
      behaviorChanging: true,
      requirements: [requirement],
      scenarios: [scenario],
      tddEvidence: { ...evidence, requirements: ["other"] },
    })).toMatchObject({ status: "blocked", reason: "TDD evidence is not linked to the task contract" });
  });

  test("accepts a reviewed non-applicability exception linked to the contract", () => {
    const exception = createTddException({
      runId: "run-1",
      taskId: "10.1",
      requirements: [requirement],
      scenarios: [scenario],
      rationale: "This task changes documentation only",
      reviewedBy: "reviewer-run-1",
      reviewedAt: "2026-09-12T12:00:00.000Z",
      createdAt: "2026-09-12T12:00:00.000Z",
    });

    expect(completion(exception)).toMatchObject({
      status: "completed",
      synchronizeCheckbox: true,
    });
  });
});