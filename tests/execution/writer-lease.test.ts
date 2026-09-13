import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  acquireWriterLease,
  type AcquireWriterLeaseOptions,
  type WriterLeaseRecord,
} from "../../src/execution/writer-lease.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-writer-lease-"));
  temporaryDirectories.push(root);
  const worktreePath = await mkdtemp(resolve(root, "worktree-"));
  const lockDirectory = resolve(root, "locks");
  const base: AcquireWriterLeaseOptions = {
    identity: {
      repositoryId: "repository-1",
      worktreePath,
      runId: "run-1",
      taskId: "6.3",
      command: "builder",
      processId: 101,
    },
    lockDirectory,
  };
  return { base };
}

describe("writer lease", () => {
  test("rejects a concurrent writer while its owner is live", async () => {
    const { base } = await fixture();
    const first = await acquireWriterLease({ ...base, processAlive: () => true });

    await expect(acquireWriterLease({
      ...base,
      identity: { ...base.identity, runId: "run-2", taskId: "6.4", processId: 202 },
      processAlive: () => true,
    })).rejects.toMatchObject({ code: "WRITER_LEASE_BUSY" });

    await first.release();
  });

  test("normal release permits the next writer", async () => {
    const { base } = await fixture();
    const first = await acquireWriterLease({ ...base, processAlive: () => true });
    await first.release();

    const second = await acquireWriterLease({
      ...base,
      identity: { ...base.identity, runId: "run-2", taskId: "6.4", processId: 202 },
      processAlive: () => true,
    });

    expect(second.record.ownerId).not.toBe(first.record.ownerId);
    await second.release();
  });

  test("recovers a crashed owner only after worktree reconciliation", async () => {
    const { base } = await fixture();
    const crashed = await acquireWriterLease({ ...base, processAlive: () => true });
    let reconciledOwner: WriterLeaseRecord | undefined;

    const recovered = await acquireWriterLease({
      ...base,
      identity: { ...base.identity, runId: "run-2", taskId: "6.4", processId: 202 },
      processAlive: () => false,
      reconcileStaleOwner: (owner) => {
        reconciledOwner = owner;
        return true;
      },
    });

    expect(reconciledOwner).toEqual(crashed.record);
    expect(recovered.recoveredRecord).toEqual(crashed.record);
    await crashed.release();
    expect(JSON.parse(await readFile(recovered.path, "utf8"))).toEqual(recovered.record);
    await recovered.release();
  });

  test("preserves a dead owner's lease when reconciliation fails", async () => {
    const { base } = await fixture();
    const crashed = await acquireWriterLease({ ...base, processAlive: () => true });

    await expect(acquireWriterLease({
      ...base,
      identity: { ...base.identity, runId: "run-2", taskId: "6.4", processId: 202 },
      processAlive: () => false,
      reconcileStaleOwner: () => false,
    })).rejects.toMatchObject({ code: "WRITER_LEASE_RECOVERY_REQUIRED" });

    expect(JSON.parse(await readFile(crashed.path, "utf8"))).toEqual(crashed.record);
    await crashed.release();
  });
});