import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const WRITER_LEASE_SCHEMA_VERSION = 1;

export interface WriterLeaseIdentity {
  repositoryId: string;
  worktreePath: string;
  runId: string;
  taskId: string;
  command: string;
  processId?: number;
}

export interface WriterLeaseRecord {
  schemaVersion: typeof WRITER_LEASE_SCHEMA_VERSION;
  ownerId: string;
  processId: number;
  repositoryId: string;
  worktreePath: string;
  runId: string;
  taskId: string;
  command: string;
  acquiredAt: string;
}

export interface WriterLease {
  path: string;
  record: WriterLeaseRecord;
  recoveredRecord: WriterLeaseRecord | null;
  release(): Promise<void>;
}

export interface AcquireWriterLeaseOptions {
  identity: WriterLeaseIdentity;
  lockDirectory?: string;
  processAlive?: (processId: number) => boolean;
  reconcileStaleOwner?: (
    stale: WriterLeaseRecord,
    requested: WriterLeaseRecord,
  ) => boolean | Promise<boolean>;
  now?: () => Date;
}

export class WriterLeaseError extends Error {
  constructor(
    readonly code: "WRITER_LEASE_BUSY" | "WRITER_LEASE_INVALID" | "WRITER_LEASE_RECOVERY_REQUIRED",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WriterLeaseError";
  }
}

function defaultProcessAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WriterLeaseError("WRITER_LEASE_INVALID", `Writer lease has invalid ${field}`, { field });
  }
  return value;
}

function parseRecord(value: string, path: string): WriterLeaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new WriterLeaseError(
      "WRITER_LEASE_INVALID",
      "Writer lease record is not valid JSON",
      { path },
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WriterLeaseError("WRITER_LEASE_INVALID", "Writer lease record is not an object", { path });
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== WRITER_LEASE_SCHEMA_VERSION) {
    throw new WriterLeaseError(
      "WRITER_LEASE_INVALID",
      "Writer lease schema version is unsupported",
      { path, schemaVersion: record.schemaVersion },
    );
  }
  if (!Number.isInteger(record.processId) || Number(record.processId) <= 0) {
    throw new WriterLeaseError("WRITER_LEASE_INVALID", "Writer lease has invalid processId", { path });
  }
  return {
    schemaVersion: WRITER_LEASE_SCHEMA_VERSION,
    ownerId: requiredString(record.ownerId, "ownerId"),
    processId: Number(record.processId),
    repositoryId: requiredString(record.repositoryId, "repositoryId"),
    worktreePath: requiredString(record.worktreePath, "worktreePath"),
    runId: requiredString(record.runId, "runId"),
    taskId: requiredString(record.taskId, "taskId"),
    command: requiredString(record.command, "command"),
    acquiredAt: requiredString(record.acquiredAt, "acquiredAt"),
  };
}

function leasePath(
  repositoryId: string,
  worktreePath: string,
  lockDirectory = resolve(tmpdir(), "muster-writer-leases"),
): string {
  const key = createHash("sha256")
    .update(repositoryId, "utf8")
    .update("\0", "utf8")
    .update(worktreePath, "utf8")
    .digest("hex");
  return resolve(lockDirectory, `${key}.lock`);
}

async function readRecord(path: string): Promise<{ raw: string; record: WriterLeaseRecord }> {
  const raw = await readFile(path, "utf8");
  return { raw, record: parseRecord(raw, path) };
}

export async function acquireWriterLease(
  options: AcquireWriterLeaseOptions,
): Promise<WriterLease> {
  const canonicalWorktree = await realpath(options.identity.worktreePath);
  const processId = options.identity.processId ?? process.pid;
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new WriterLeaseError("WRITER_LEASE_INVALID", "Writer lease processId must be positive", { processId });
  }
  const record: WriterLeaseRecord = {
    schemaVersion: WRITER_LEASE_SCHEMA_VERSION,
    ownerId: randomUUID(),
    processId,
    repositoryId: requiredString(options.identity.repositoryId, "repositoryId"),
    worktreePath: canonicalWorktree,
    runId: requiredString(options.identity.runId, "runId"),
    taskId: requiredString(options.identity.taskId, "taskId"),
    command: requiredString(options.identity.command, "command"),
    acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const path = leasePath(record.repositoryId, canonicalWorktree, options.lockDirectory);
  const processAlive = options.processAlive ?? defaultProcessAlive;
  await mkdir(resolve(path, ".."), { recursive: true });
  let recoveredRecord: WriterLeaseRecord | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        path,
        record,
        recoveredRecord,
        async release() {
          try {
            const current = await readRecord(path);
            if (current.record.ownerId === record.ownerId) await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readRecord(path);
      if (processAlive(existing.record.processId)) {
        throw new WriterLeaseError(
          "WRITER_LEASE_BUSY",
          `Writer lease is held by live task ${existing.record.taskId} in run ${existing.record.runId}`,
          { path, owner: existing.record },
        );
      }
      if (
        existing.record.repositoryId !== record.repositoryId ||
        existing.record.worktreePath !== record.worktreePath
      ) {
        throw new WriterLeaseError(
          "WRITER_LEASE_INVALID",
          "Stale writer lease identity does not match the requested worktree",
          { path, owner: existing.record, requested: record },
        );
      }
      const reconciled = await options.reconcileStaleOwner?.(existing.record, record);
      if (!reconciled || processAlive(existing.record.processId)) {
        throw new WriterLeaseError(
          "WRITER_LEASE_RECOVERY_REQUIRED",
          "Dead writer lease cannot be removed until its worktree state is reconciled",
          { path, owner: existing.record },
        );
      }
      const current = await readRecord(path);
      if (current.raw !== existing.raw) continue;
      await unlink(path);
      recoveredRecord = existing.record;
    }
  }
  throw new WriterLeaseError(
    "WRITER_LEASE_BUSY",
    "Writer lease changed repeatedly during acquisition",
    { path },
  );
}