import type { AtomicJsonStore } from "./atomic-json-store.ts";
import { changeRunId, createChangeUsageStore } from "./change-usage-store.ts";
import { runManifestSchema, type RunManifest } from "./records.ts";

export async function readRunRecords<T>(
  store: AtomicJsonStore,
  runId: string,
  directory: string,
  schema: { parse(value: unknown): T },
): Promise<T[]> {
  const paths = await store.list(runId, directory);
  return Promise.all(paths.map(async (path) => schema.parse(await store.read(runId, path))));
}

export interface ChangeRun {
  store: AtomicJsonStore;
  runId: string;
  readManifest(): Promise<RunManifest>;
  /** Resolves to null when the run has no manifest yet, instead of throwing ENOENT. */
  readManifestOrNull(): Promise<RunManifest | null>;
  writeManifest(manifest: RunManifest): Promise<void>;
  readRecords<T>(directory: string, schema: { parse(value: unknown): T }): Promise<T[]>;
}

/** Opens the persisted run namespace for a change: its store, stable run id, and manifest access. */
export function openChangeRun(cwd: string, changeName: string): ChangeRun {
  const store = createChangeUsageStore(cwd);
  const runId = changeRunId(changeName);
  return {
    store,
    runId,
    readManifest: async () => runManifestSchema.parse(await store.read(runId, "manifest.json")),
    async readManifestOrNull() {
      try {
        return runManifestSchema.parse(await store.read(runId, "manifest.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return null;
      }
    },
    writeManifest: (manifest) => store.write(runId, "manifest.json", manifest),
    readRecords: (directory, schema) => readRunRecords(store, runId, directory, schema),
  };
}
