import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  checkpointPlannedManualAction,
  guardRuntimeManualAction,
  loadManualCheckpoint,
} from "../../src/controller/manual-checkpoint.ts";
import { restoreManualCheckpointNotifications } from "../../src/change/manual-ui.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import type {
  CheckpointRecord,
  ManualActionCategory,
} from "../../src/persistence/records.ts";
import { createUsageRecord } from "../../src/telemetry/usage.ts";

interface ManualFixture {
  secret: string;
  runtime: Array<{
    category: ManualActionCategory;
    executable: string;
    args: string[];
  }>;
  planned: {
    category: ManualActionCategory;
    reason: string;
    instructions: string[];
    expectedOutcome: string;
    resumeTarget: string;
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function readAllFiles(directory: string): Promise<string[]> {
  const contents: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) contents.push(...await readAllFiles(path));
    else if (entry.isFile()) contents.push(await readFile(path, "utf8"));
  }
  return contents;
}

describe("manual checkpoint end-to-end flow", () => {
  test("stops all mandatory categories and restores only sanitized state", async () => {
    const fixture = JSON.parse(await readFile(
      resolve(import.meta.dir, "../fixtures/manual/actions.json"),
      "utf8",
    )) as ManualFixture;
    const root = await mkdtemp(resolve(tmpdir(), "muster-manual-e2e-"));
    temporaryDirectories.push(root);
    const store = new AtomicJsonStore(root);
    const context = {
      store,
      runId: "run-1",
      changeName: "manual-flow",
      taskId: "9.4",
      branch: ["9.4"],
      secretValues: [fixture.secret],
    };
    const checkpoints: CheckpointRecord[] = [];
    let executions = 0;

    for (const action of fixture.runtime) {
      const result = await guardRuntimeManualAction({
        ...context,
        request: {
          profile: "verification",
          executable: action.executable,
          args: action.args,
          cwd: root,
        },
      }, async () => {
        executions++;
        return "executed";
      });
      expect(result.status).toBe("awaiting_user");
      if (result.status !== "awaiting_user") throw new Error("expected checkpoint");
      expect(result.checkpoint.category).toBe(action.category);
      checkpoints.push(result.checkpoint);
    }

    checkpoints.push(await checkpointPlannedManualAction({
      ...context,
      manual: fixture.planned,
    }));
    expect(executions).toBe(0);
    expect(new Set(checkpoints.map((checkpoint) => checkpoint.category))).toEqual(new Set([
      "authentication",
      "elevated_permission",
      "destructive",
      "external_side_effect",
      "design_decision",
    ]));

    await store.write("run-1", "usage/manual-flow.json", createUsageRecord({
      runId: "run-1",
      phase: "implementation",
      role: "builder",
      taskId: "9.4",
      model: { provider: "openai", id: "test-model" },
      usage: { input: 10, output: 2 },
      durationMs: 25,
    }));

    const restartedStore = new AtomicJsonStore(root);
    const restored = await Promise.all(checkpoints.map((checkpoint) =>
      loadManualCheckpoint(restartedStore, "run-1", checkpoint.id)
    ));
    const notifications: string[] = [];
    expect(restoreManualCheckpointNotifications({
      checkpoints: restored,
      ui: { notify: (message) => notifications.push(message) },
    })).toHaveLength(5);
    expect(restored.every((checkpoint) => checkpoint.status === "pending")).toBeTrue();

    const persistedContents = (await readAllFiles(root)).join("\n");
    expect(persistedContents).not.toContain(fixture.secret);
    expect(notifications.join("\n")).not.toContain(fixture.secret);
  });
});