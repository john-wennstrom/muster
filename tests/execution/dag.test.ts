import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  compileTaskDag,
  dependencyClosure,
  persistTaskDag,
} from "../../src/execution/delegation-dag.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const digest = "a".repeat(64);
const createdAt = "2026-09-12T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("task delegation DAG", () => {
  test("compiles deterministic ordering and dependency closure", () => {
    const tasks = [
      { id: "2.1", dependsOn: ["1.2", "1.1"], checked: false },
      { id: "1.2", dependsOn: ["1.1"], checked: false },
      { id: "1.1", dependsOn: [], checked: true },
    ];

    const first = compileTaskDag(tasks, digest, createdAt);
    const second = compileTaskDag([...tasks].reverse(), digest, createdAt);

    expect(second).toEqual(first);
    expect(first.topologicalOrder).toEqual(["1.1", "1.2", "2.1"]);
    expect(dependencyClosure(first, "2.1")).toEqual(["1.1", "1.2"]);
  });

  test("rejects unknown dependencies and reports complete cycle paths", () => {
    expect(() => compileTaskDag([
      { id: "1.1", dependsOn: ["9.9"], checked: false },
    ], digest, createdAt)).toThrow(expect.objectContaining({
      code: "TASK_DAG_INVALID",
      details: expect.objectContaining({ taskId: "1.1", dependencyId: "9.9" }),
    }) as HarnessError);

    expect(() => compileTaskDag([
      { id: "1.1", dependsOn: ["1.2"], checked: false },
      { id: "1.2", dependsOn: ["1.3"], checked: false },
      { id: "1.3", dependsOn: ["1.1"], checked: false },
    ], digest, createdAt)).toThrow(expect.objectContaining({
      code: "TASK_DAG_INVALID",
      details: expect.objectContaining({ cycle: ["1.1", "1.2", "1.3", "1.1"] }),
    }) as HarnessError);
  });

  test("rejects removal of a previously incomplete task", () => {
    const previous = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: true },
      { id: "1.2", dependsOn: ["1.1"], checked: false },
    ], "b".repeat(64), createdAt);

    expect(() => compileTaskDag([
      { id: "1.1", dependsOn: [], checked: true },
    ], digest, createdAt, previous)).toThrow(expect.objectContaining({
      code: "TASK_DAG_INVALID",
      details: expect.objectContaining({ removedTaskId: "1.2" }),
    }) as HarnessError);
  });

  test("persists one immutable snapshot per tasks digest", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-dag-"));
    temporaryDirectories.push(root);
    const store = new AtomicJsonStore(resolve(root, ".fusion/runs"));
    const snapshot = compileTaskDag([
      { id: "1.1", dependsOn: [], checked: false },
    ], digest, createdAt);

    await persistTaskDag(store, "run-1", snapshot);
    await persistTaskDag(store, "run-1", snapshot);
    await expect(persistTaskDag(store, "run-1", {
      ...snapshot,
      nodes: [{ id: "other", dependsOn: [], checked: false }],
      topologicalOrder: ["other"],
    })).rejects.toMatchObject({ code: "TASK_DAG_IMMUTABLE" } as HarnessError);
  });
});