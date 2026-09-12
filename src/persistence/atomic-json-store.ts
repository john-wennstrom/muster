import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { HarnessError } from "../shared/errors.ts";

export interface VersionedRecord {
  schemaVersion: number;
}

export interface AtomicJsonStoreHooks {
  beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void> | void;
}

function validateRelativePath(value: string, label: string): void {
  const segments = value.split(/[\\/]/);
  if (
    !value ||
    isAbsolute(value) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new HarnessError(
      "PERSISTENCE_PATH_INVALID",
      `Invalid ${label}: ${value}`,
      { label, value },
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  }
}

export class AtomicJsonStore {
  readonly runsRoot: string;
  private readonly hooks: AtomicJsonStoreHooks;

  constructor(runsRoot: string, hooks: AtomicJsonStoreHooks = {}) {
    this.runsRoot = resolve(runsRoot);
    this.hooks = hooks;
  }

  async write<T extends VersionedRecord>(
    runId: string,
    recordPath: string,
    record: T,
  ): Promise<void> {
    validateRelativePath(runId, "run id");
    validateRelativePath(recordPath, "record path");
    if (!Number.isInteger(record.schemaVersion) || record.schemaVersion < 1) {
      throw new HarnessError(
        "PERSISTENCE_VERSION_INVALID",
        `Invalid schema version: ${record.schemaVersion}`,
        { schemaVersion: record.schemaVersion },
      );
    }

    const targetPath = resolve(this.runsRoot, runId, recordPath);
    const runRoot = `${resolve(this.runsRoot, runId)}${sep}`;
    if (!targetPath.startsWith(runRoot)) {
      throw new HarnessError(
        "PERSISTENCE_PATH_INVALID",
        `Record escapes run directory: ${recordPath}`,
        { runId, recordPath },
      );
    }

    const targetDirectory = dirname(targetPath);
    const temporaryPath = resolve(
      targetDirectory,
      `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(targetDirectory, { recursive: true });

    let file;
    try {
      file = await open(temporaryPath, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await this.hooks.beforeRename?.(temporaryPath, targetPath);
      await rename(temporaryPath, targetPath);
      await syncDirectory(targetDirectory);
    } catch (error) {
      await file?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async read<T extends VersionedRecord>(runId: string, recordPath: string): Promise<T> {
    validateRelativePath(runId, "run id");
    validateRelativePath(recordPath, "record path");
    return JSON.parse(
      await readFile(resolve(this.runsRoot, runId, recordPath), "utf8"),
    ) as T;
  }
}