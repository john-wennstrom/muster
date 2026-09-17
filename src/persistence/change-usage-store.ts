import { resolve } from "node:path";
import { AtomicJsonStore, type VersionedRecord } from "./atomic-json-store.ts";
import { aggregateUsage, type UsagePhase, type UsageRecord } from "../telemetry/usage.ts";
import { HarnessError } from "../shared/errors.ts";

const phases: readonly UsagePhase[] = ["planning", "implementation", "validation"];

/** Deterministic, filesystem-safe run namespace shared by a change's manifest, checkpoints, and usage records. */
export function changeRunId(changeName: string): string {
  const slug = changeName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new HarnessError(
      "PERSISTENCE_PATH_INVALID",
      "Change name cannot produce a safe run identifier",
      { changeName },
    );
  }
  return `run-${slug}`;
}

export function defaultRunsRoot(cwd: string): string {
  return resolve(cwd, ".fusion", "runs");
}

export function createChangeUsageStore(cwd: string): AtomicJsonStore {
  return new AtomicJsonStore(defaultRunsRoot(cwd));
}

export async function recordChangeUsage(
  store: AtomicJsonStore,
  changeName: string,
  records: readonly UsageRecord[],
): Promise<void> {
  const runId = changeRunId(changeName);
  for (const record of records) {
    await store.write(runId, `usage/${record.invocationId}.json`, record);
  }
}

export async function listChangeUsage(
  store: AtomicJsonStore,
  changeName: string,
): Promise<UsageRecord[]> {
  const runId = changeRunId(changeName);
  const paths = await store.list(runId, "usage");
  const records: UsageRecord[] = [];
  for (const path of paths) {
    records.push(await store.read<UsageRecord & VersionedRecord>(runId, path));
  }
  return records;
}

export interface ChangeUsageSummary {
  changeName: string;
  total: ReturnType<typeof aggregateUsage>;
  byPhase: Readonly<Record<UsagePhase, ReturnType<typeof aggregateUsage>>>;
}

export function summarizeChangeUsage(
  changeName: string,
  records: readonly UsageRecord[],
): ChangeUsageSummary {
  const byPhase = Object.fromEntries(
    phases.map((phase) => [phase, aggregateUsage(records.filter((record) => record.phase === phase))]),
  ) as Record<UsagePhase, ReturnType<typeof aggregateUsage>>;
  return {
    changeName,
    total: aggregateUsage(records),
    byPhase: Object.freeze(byPhase),
  };
}

export async function loadChangeUsageSummary(
  store: AtomicJsonStore,
  changeName: string,
): Promise<ChangeUsageSummary | null> {
  const records = await listChangeUsage(store, changeName);
  if (records.length === 0) return null;
  return summarizeChangeUsage(changeName, records);
}

interface ActiveChangeRecord extends VersionedRecord {
  schemaVersion: 1;
  changeName: string;
  updatedAt: string;
}

const ACTIVE_CHANGE_RUN_ID = "control";
const ACTIVE_CHANGE_RECORD_PATH = "active-change.json";

export async function setActiveChange(
  store: AtomicJsonStore,
  changeName: string,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  const record: ActiveChangeRecord = {
    schemaVersion: 1,
    changeName,
    updatedAt: now(),
  };
  await store.write(ACTIVE_CHANGE_RUN_ID, ACTIVE_CHANGE_RECORD_PATH, record);
}

export async function getActiveChange(store: AtomicJsonStore): Promise<string | null> {
  try {
    const record = await store.read<ActiveChangeRecord>(ACTIVE_CHANGE_RUN_ID, ACTIVE_CHANGE_RECORD_PATH);
    return record.changeName;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
