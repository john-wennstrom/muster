import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { changeRunId } from "../../src/persistence/change-usage-store.ts";
import {
  REVIEW_SNAPSHOT_DIRECTORY,
  REVIEW_SNAPSHOT_LIMIT,
  loadReviewSnapshot,
  saveReviewSnapshot,
  type NewReviewSnapshot,
} from "../../src/review/review-snapshot.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function newStore(): Promise<AtomicJsonStore> {
  const root = await mkdtemp(resolve(tmpdir(), "muster-review-snapshot-"));
  temporaryDirectories.push(root);
  return new AtomicJsonStore(root);
}

const digestOf = (character: string) => character.repeat(64);

function snapshot(character: string): NewReviewSnapshot {
  return {
    artifactDigest: digestOf(character),
    files: {
      "openspec/changes/x/proposal.md": digestOf("1"),
      "openspec/changes/x/design.md": digestOf("2"),
      "openspec/changes/x/tasks.md": digestOf("3"),
      "openspec/changes/x/specs/x/spec.md": digestOf("4"),
    },
    proposal: { path: "openspec/changes/x/proposal.md", text: `proposal ${character}\n` },
    design: { path: "openspec/changes/x/design.md", text: `design ${character}\n` },
  };
}

const at = (minute: number) => () => new Date(Date.UTC(2026, 8, 20, 12, minute));

describe("review snapshot retention", () => {
  test("a round trip preserves every digest and the two texts", async () => {
    const store = await newStore();
    await saveReviewSnapshot(store, "add-search", snapshot("a"), at(0));

    const loaded = await loadReviewSnapshot(store, "add-search", digestOf("a"));
    expect(loaded).toMatchObject(snapshot("a"));
    expect(loaded?.savedAt).toBe("2026-09-20T12:00:00.000Z");
  });

  test("no other file's text is stored", async () => {
    const store = await newStore();
    await saveReviewSnapshot(store, "add-search", snapshot("a"), at(0));

    const runDirectory = resolve(store.runsRoot, changeRunId("add-search"), REVIEW_SNAPSHOT_DIRECTORY);
    const [name] = await readdir(runDirectory);
    const raw = await readFile(resolve(runDirectory, name!), "utf8");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(
      ["artifactDigest", "design", "files", "proposal", "savedAt", "schemaVersion"],
    );
    expect(raw).toContain("proposal a");
    expect(raw).not.toContain("- [ ] 1.1");
  });

  test("keeps the three most recent and prunes the rest", async () => {
    const store = await newStore();
    for (const [index, character] of ["a", "b", "c", "d"].entries()) {
      await saveReviewSnapshot(store, "add-search", snapshot(character), at(index));
    }

    expect(REVIEW_SNAPSHOT_LIMIT).toBe(3);
    expect(await loadReviewSnapshot(store, "add-search", digestOf("a"))).toBeNull();
    for (const character of ["b", "c", "d"]) {
      expect(await loadReviewSnapshot(store, "add-search", digestOf(character))).not.toBeNull();
    }
    expect(await readdir(resolve(store.runsRoot, changeRunId("add-search"), REVIEW_SNAPSHOT_DIRECTORY))).toHaveLength(3);
  });

  test("saving an older-dated snapshot does not evict a newer one", async () => {
    const store = await newStore();
    for (const [index, character] of ["a", "b", "c"].entries()) {
      await saveReviewSnapshot(store, "add-search", snapshot(character), at(10 + index));
    }
    await saveReviewSnapshot(store, "add-search", snapshot("d"), at(0));

    expect(await loadReviewSnapshot(store, "add-search", digestOf("d"))).toBeNull();
    expect(await loadReviewSnapshot(store, "add-search", digestOf("c"))).not.toBeNull();
  });

  test("snapshots are kept per change", async () => {
    const store = await newStore();
    await saveReviewSnapshot(store, "add-search", snapshot("a"), at(0));
    expect(await loadReviewSnapshot(store, "other-change", digestOf("a"))).toBeNull();
  });

  test("a missing snapshot loads as absent without raising", async () => {
    const store = await newStore();
    expect(await loadReviewSnapshot(store, "add-search", digestOf("a"))).toBeNull();
    await saveReviewSnapshot(store, "add-search", snapshot("b"), at(0));
    expect(await loadReviewSnapshot(store, "add-search", digestOf("a"))).toBeNull();
  });

  test("a malformed digest loads as absent", async () => {
    const store = await newStore();
    expect(await loadReviewSnapshot(store, "add-search", "../escape")).toBeNull();
  });
});
