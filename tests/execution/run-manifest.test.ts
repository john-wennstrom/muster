import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { escalateLane, writeLane } from "../../src/controller/lane.ts";
import { RunManifestKeeper, type OpenRunManifestInput } from "../../src/execution/run-manifest.ts";
import type { ValidatedTaskDocument } from "../../src/execution/task-schema.ts";
import type { ChangeWorktree } from "../../src/execution/worktree.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { runManifestSchema } from "../../src/persistence/records.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const clock = () => new Date("2026-09-21T10:00:00.000Z");

const worktree: ChangeWorktree = {
  repositoryId: "repo-1",
  commonDirectory: "/repo/.git",
  path: "/repo-worktrees/add-search",
  branch: "muster/add-search",
  head: "a".repeat(40),
  reused: false,
};

const document = {
  tasks: [{ id: "1.1", checked: false }, { id: "1.2", checked: true }],
} as unknown as ValidatedTaskDocument;

async function setup() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-run-manifest-"));
  roots.push(root);
  const store = new AtomicJsonStore(resolve(root, "runs"));
  const input = (overrides: Partial<OpenRunManifestInput> = {}): OpenRunManifestInput => ({
    store,
    runId: "run-1",
    changeName: "add-search",
    worktree,
    artifactDigest: "digest-1",
    document,
    creation: {
      head: worktree.head,
      gitStatus: [],
      diff: "",
      modelAssignments: { builder: "openai/builder" },
    },
    now: clock,
    ...overrides,
  });
  const persisted = async () => runManifestSchema.parse(await store.read("run-1", "manifest.json"));
  return { store, input, persisted };
}

describe("RunManifestKeeper", () => {
  test("creates a manifest with task states and the change's lane", async () => {
    const { store, input, persisted } = await setup();
    await writeLane(store, "add-search", { lane: "small", source: "user", reasons: ["asked"] });

    const keeper = await RunManifestKeeper.open(input());

    expect(keeper.artifactChanged).toBe(false);
    expect(keeper.current.tasks).toEqual({ "1.1": "ready", "1.2": "completed" });
    expect(keeper.current.lane).toBe("small");
    expect(await persisted()).toEqual(keeper.current);
  });

  test("a change with no lane record is recorded as medium", async () => {
    const { input } = await setup();
    expect((await RunManifestKeeper.open(input())).current.lane).toBe("medium");
  });

  test("reads an existing manifest, reports a changed artifact digest, and refreshes the lane", async () => {
    const { store, input, persisted } = await setup();
    await writeLane(store, "add-search", { lane: "small", source: "user", reasons: ["asked"] });
    await RunManifestKeeper.open(input());
    await escalateLane(store, "add-search", "large", "the change touches more than planned");

    const reopened = await RunManifestKeeper.open(input({ artifactDigest: "digest-2" }));

    expect(reopened.artifactChanged).toBe(true);
    expect(reopened.current.lane).toBe("large");
    expect((await persisted()).lane).toBe("large");
  });

  test("refuses a manifest recorded for another worktree", async () => {
    const { input } = await setup();
    await RunManifestKeeper.open(input());
    await expect(RunManifestKeeper.open(input({ worktree: { ...worktree, path: "/elsewhere" } })))
      .rejects.toMatchObject({ code: "RECOVERY_STATE_CONFLICT" });
  });

  test("records task states, pending checkpoints and the lifecycle they imply", async () => {
    const { input, persisted } = await setup();
    const keeper = await RunManifestKeeper.open(input());

    await keeper.recordTask("1.1", "awaiting_user", ["cp-1"]);
    expect(await persisted()).toMatchObject({ lifecycle: "AWAITING_USER", checkpoints: ["cp-1"] });

    await keeper.recordTask("1.1", "completed", ["cp-1"]);
    expect(await persisted()).toMatchObject({ lifecycle: "IMPLEMENTING", checkpoints: ["cp-1"], tasks: { "1.1": "completed" } });

    await keeper.recordTask("1.1", "design_conflict", []);
    expect((await persisted()).lifecycle).toBe("DESIGN_CONFLICT");
  });

  test("records an escalated lane and where the run ended", async () => {
    const { input, persisted } = await setup();
    const keeper = await RunManifestKeeper.open(input());

    await keeper.recordLane("large");
    await keeper.finish("BLOCKED", { "1.1": "blocked" });

    expect(await persisted()).toMatchObject({ lane: "large", lifecycle: "BLOCKED", tasks: { "1.1": "blocked", "1.2": "completed" } });
  });
});
