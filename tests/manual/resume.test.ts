import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  confirmManualCheckpoint,
  createManualCheckpoint,
  loadManualCheckpoint,
} from "../../src/controller/manual-checkpoint.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-manual-resume-"));
  temporaryDirectories.push(root);
  const store = new AtomicJsonStore(root);
  const checkpoint = await createManualCheckpoint({
    store,
    runId: "run-1",
    changeName: "add-search",
    taskId: "9.1",
    branch: ["9.1", "9.2"],
    category: "authentication",
    reason: "Authentication must be completed by the user",
    instructions: ["Authenticate directly in a trusted terminal"],
    resumeTarget: "9.1",
  });
  return { store, checkpoint };
}

describe("manual checkpoint resume", () => {
  test("stays pending until explicitly confirmed and records audit metadata", async () => {
    const { store, checkpoint } = await fixture();

    expect((await loadManualCheckpoint(store, "run-1", checkpoint.id)).status).toBe("pending");
    const confirmed = await confirmManualCheckpoint({
      store,
      runId: "run-1",
      changeName: "add-search",
      checkpointId: checkpoint.id,
      confirmedBy: "local-user",
      now: () => new Date("2026-09-12T13:00:00.000Z"),
    });
    const persisted = await loadManualCheckpoint(store, "run-1", checkpoint.id);

    expect(confirmed).toEqual(persisted);
    expect(confirmed).toMatchObject({
      status: "confirmed",
      confirmedBy: "local-user",
      confirmedAt: "2026-09-12T13:00:00.000Z",
      resumeTarget: "9.1",
    });
  });

  test("rejects mismatched and repeated confirmation", async () => {
    const { store, checkpoint } = await fixture();
    const options = {
      store,
      runId: "run-1",
      confirmedBy: "local-user",
      checkpointId: checkpoint.id,
    };

    await expect(confirmManualCheckpoint({ ...options, changeName: "other" }))
      .rejects.toMatchObject({ code: "MANUAL_CHECKPOINT_MISMATCH" });
    await confirmManualCheckpoint({ ...options, changeName: "add-search" });
    await expect(confirmManualCheckpoint({ ...options, changeName: "add-search" }))
      .rejects.toMatchObject({ code: "MANUAL_CHECKPOINT_CONFIRMED" });
  });
});
