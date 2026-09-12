import { describe, expect, test } from "bun:test";
import {
  decodePersistedRecord,
  persistenceRecordSchemas,
} from "../../src/persistence/records.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const timestamp = "2026-09-12T12:00:00.000Z";

const records = {
  manifest: {
    schemaVersion: 1,
    runId: "run-1",
    changeName: "add-search",
    lifecycle: "IMPLEMENTING",
    repository: { id: "repo-1", commonDirectory: "/repo/.git" },
    worktree: { path: "/repo-worktrees/add-search", head: "a".repeat(40) },
    artifactDigest: "digest",
    tasks: { "1.1": "ready" },
    modelAssignments: { builder: "openai/example" },
    writer: null,
    checkpoints: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  taskResult: {
    schemaVersion: 1,
    runId: "run-1",
    taskId: "1.1",
    outcome: "completed",
    sourceDigest: "source",
    verificationEvidence: ["bun test"],
    completedAt: timestamp,
  },
  review: {
    schemaVersion: 1,
    runId: "run-1",
    kind: "task",
    verdict: "APPROVE",
    artifactDigest: "digest",
    model: "openai/example",
    findings: [],
    createdAt: timestamp,
  },
  validation: {
    schemaVersion: 1,
    runId: "run-1",
    result: "PASS",
    sourceDigest: "source",
    artifactDigest: "digest",
    commands: [{ command: "bun test", exitCode: 0 }],
    createdAt: timestamp,
  },
  checkpoint: {
    schemaVersion: 1,
    id: "checkpoint-1",
    runId: "run-1",
    changeName: "add-search",
    taskId: "1.1",
    branch: ["1.1", "1.2"],
    category: "authentication",
    reason: "Provider authentication is required",
    instructions: ["Authenticate directly in Pi"],
    createdAt: timestamp,
    status: "pending",
    resumeTarget: "1.1",
  },
  migration: {
    schemaVersion: 1,
    fromVersion: 0,
    toVersion: 1,
    migratedAt: timestamp,
    records: ["manifest.json"],
  },
} as const;

describe("persistence record schemas", () => {
  test("accepts every current record kind", () => {
    for (const [kind, schema] of Object.entries(persistenceRecordSchemas)) {
      expect(schema.parse(records[kind as keyof typeof records])).toBeDefined();
    }
  });

  test("fails closed on unsupported schema versions", () => {
    try {
      decodePersistedRecord(
        "manifest",
        JSON.stringify({ ...records.manifest, schemaVersion: 2 }),
        ".fusion/runs/run-1/manifest.json",
      );
      throw new Error("unsupported record unexpectedly passed");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe("PERSISTENCE_UNSUPPORTED_VERSION");
      expect((error as HarnessError).details.path).toBe(".fusion/runs/run-1/manifest.json");
    }
  });

  test("fails closed on malformed JSON", () => {
    expect(() =>
      decodePersistedRecord("taskResult", "{", "task-results/1.1.json"),
    ).toThrow(expect.objectContaining({ code: "PERSISTENCE_CORRUPT_RECORD" }));
  });

  test("reports the exact invalid field path", () => {
    try {
      decodePersistedRecord(
        "checkpoint",
        JSON.stringify({ ...records.checkpoint, instructions: [42] }),
        "checkpoints/checkpoint-1.json",
      );
      throw new Error("corrupt record unexpectedly passed");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe("PERSISTENCE_CORRUPT_RECORD");
      expect((error as HarnessError).details.issues).toContainEqual(
        expect.objectContaining({ path: "instructions.0" }),
      );
    }
  });
});