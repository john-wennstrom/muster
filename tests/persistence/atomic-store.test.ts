import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  AtomicJsonStore,
  type VersionedRecord,
} from "../../src/persistence/atomic-json-store.ts";
import { HarnessError } from "../../src/shared/errors.ts";

interface TestRecord extends VersionedRecord {
  value: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryStore(hooks = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-store-"));
  temporaryDirectories.push(root);
  return { root, store: new AtomicJsonStore(resolve(root, ".fusion/runs"), hooks) };
}

describe("atomic JSON store", () => {
  test("writes schema-versioned records under a run directory", async () => {
    const { root, store } = await temporaryStore();
    const record: TestRecord = { schemaVersion: 1, value: "current" };

    await store.write("run-1", "manifest.json", record);

    expect(await store.read<TestRecord>("run-1", "manifest.json")).toEqual(record);
    expect(JSON.parse(await readFile(resolve(root, ".fusion/runs/run-1/manifest.json"), "utf8"))).toEqual(record);
  });

  test("preserves the last valid record when interrupted before rename", async () => {
    let interrupt = false;
    const { root, store } = await temporaryStore({
      beforeRename: () => {
        if (interrupt) throw new Error("injected interruption");
      },
    });
    await store.write("run-1", "manifest.json", { schemaVersion: 1, value: "old" });

    interrupt = true;
    await expect(
      store.write("run-1", "manifest.json", { schemaVersion: 1, value: "new" }),
    ).rejects.toThrow("injected interruption");

    expect(await store.read<TestRecord>("run-1", "manifest.json")).toEqual({
      schemaVersion: 1,
      value: "old",
    });
    expect(await readdir(resolve(root, ".fusion/runs/run-1"))).toEqual(["manifest.json"]);
  });

  test("rejects invalid versions and paths outside the run", async () => {
    const { store } = await temporaryStore();

    await expect(
      store.write("../other", "manifest.json", { schemaVersion: 1 }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_PATH_INVALID" } as HarnessError);
    await expect(
      store.write("run-1", "manifest.json", { schemaVersion: 0 }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_VERSION_INVALID" } as HarnessError);
  });

  test("ignores persisted run state by default", async () => {
    const gitignore = await readFile(resolve(import.meta.dir, "../../.gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain(".fusion/runs/");
  });
});