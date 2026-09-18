import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createManualCheckpoint,
  loadManualCheckpoint,
} from "../../src/controller/manual-checkpoint.ts";
import {
  handleManualResumeCommand,
  renderManualCheckpointStatus,
  restoreManualCheckpointNotifications,
} from "../../src/change/manual-ui.ts";
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
  test("restores a prominent notification without auto-confirming", async () => {
    const { store, checkpoint } = await fixture();
    const notifications: Array<{ message: string; level?: string }> = [];

    const restored = restoreManualCheckpointNotifications({
      checkpoints: [checkpoint],
      ui: {
        notify: (message, level) => notifications.push({ message, level }),
      },
    });
    const persisted = await loadManualCheckpoint(store, "run-1", checkpoint.id);

    expect(restored).toEqual([checkpoint.id]);
    expect(persisted.status).toBe("pending");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.level).toBe("warning");
    expect(notifications[0]?.message).toContain("ACTION REQUIRED");
    expect(notifications[0]?.message).toContain("add-search");
    expect(notifications[0]?.message).toContain("Task: 9.1");
    expect(notifications[0]?.message).toContain(
      `/change resume add-search ${checkpoint.id}`,
    );
  });

  test("confirms only an explicit resume command and records audit metadata", async () => {
    const { store, checkpoint } = await fixture();
    const notifications: string[] = [];

    const confirmed = await handleManualResumeCommand({
      args: `resume add-search ${checkpoint.id}`,
      runId: "run-1",
      confirmedBy: "local-user",
      store,
      now: () => new Date("2026-09-12T13:00:00.000Z"),
      ui: { notify: (message) => notifications.push(message) },
    });
    const persisted = await loadManualCheckpoint(store, "run-1", checkpoint.id);

    expect(confirmed).toEqual(persisted);
    expect(confirmed).toMatchObject({
      status: "confirmed",
      confirmedBy: "local-user",
      confirmedAt: "2026-09-12T13:00:00.000Z",
      resumeTarget: "9.1",
    });
    expect(notifications[0]).toContain("confirmed");
    expect(renderManualCheckpointStatus(confirmed)).toContain("Confirmed by local-user");
  });

  test("rejects implicit, mismatched, and repeated confirmation", async () => {
    const { store, checkpoint } = await fixture();
    const options = {
      runId: "run-1",
      confirmedBy: "local-user",
      store,
      ui: { notify: () => undefined },
    };

    await expect(handleManualResumeCommand({ ...options, args: `add-search ${checkpoint.id}` }))
      .rejects.toMatchObject({ code: "MANUAL_RESUME_INVALID" });
    await expect(handleManualResumeCommand({ ...options, args: `resume other ${checkpoint.id}` }))
      .rejects.toMatchObject({ code: "MANUAL_CHECKPOINT_MISMATCH" });
    await handleManualResumeCommand({
      ...options,
      args: `resume add-search ${checkpoint.id}`,
    });
    await expect(handleManualResumeCommand({
      ...options,
      args: `resume add-search ${checkpoint.id}`,
    })).rejects.toMatchObject({ code: "MANUAL_CHECKPOINT_CONFIRMED" });
  });
});