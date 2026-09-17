import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryStore() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-store-list-"));
  temporaryDirectories.push(root);
  return new AtomicJsonStore(resolve(root, ".fusion/runs"));
}

describe("atomic JSON store listing", () => {
  test("lists record paths under a subdirectory in sorted order", async () => {
    const store = await temporaryStore();
    await store.write("run-1", "usage/b.json", { schemaVersion: 1 });
    await store.write("run-1", "usage/a.json", { schemaVersion: 1 });

    expect(await store.list("run-1", "usage")).toEqual(["usage/a.json", "usage/b.json"]);
  });

  test("returns an empty list for a missing subdirectory", async () => {
    const store = await temporaryStore();
    await store.write("run-1", "manifest.json", { schemaVersion: 1 });

    expect(await store.list("run-1", "usage")).toEqual([]);
    expect(await store.list("missing-run", "usage")).toEqual([]);
  });
});
