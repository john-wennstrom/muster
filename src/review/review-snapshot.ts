import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { changeRunId } from "../persistence/change-usage-store.ts";

/**
 * What a planning review approved, kept so that a later edit can be compared against it. The
 * review artifact records a digest, not the text it came from, so without this there is no way
 * to say what changed between an approval and the next edit.
 *
 * Only the proposal and the design keep their text. Every reviewed file keeps a digest, which is
 * enough to tell that a specification or the task list changed, was added, or was removed; the
 * text of those files is never retained, because it is never sent anywhere.
 */

export const REVIEW_SNAPSHOT_DIRECTORY = "review-snapshots";

/** The number of retentions kept per change. Older ones are removed when a new one is saved. */
export const REVIEW_SNAPSHOT_LIMIT = 3;

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const proseSchema = z.object({ path: z.string().min(1), text: z.string() }).strict();

export const reviewSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactDigest: digest,
    savedAt: z.string().datetime({ offset: true }),
    /** A digest for every reviewed file, keyed by repository-relative path. */
    files: z.record(z.string().min(1), digest),
    proposal: proseSchema,
    design: proseSchema,
  })
  .strict();

export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;

export type NewReviewSnapshot = Omit<ReviewSnapshot, "schemaVersion" | "savedAt">;

function snapshotPath(artifactDigest: string): string {
  return `${REVIEW_SNAPSHOT_DIRECTORY}/${artifactDigest}.json`;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Retains a snapshot under the change's run identifier and prunes to the most recent
 * `REVIEW_SNAPSHOT_LIMIT`, by the time each was saved.
 */
export async function saveReviewSnapshot(
  store: AtomicJsonStore,
  changeName: string,
  snapshot: NewReviewSnapshot,
  now: () => Date = () => new Date(),
): Promise<void> {
  const runId = changeRunId(changeName);
  const record = reviewSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: 1,
    savedAt: now().toISOString(),
  });
  await store.write(runId, snapshotPath(record.artifactDigest), record);

  const retained = await listSnapshots(store, runId);
  const stale = retained
    .sort((left, right) =>
      right.snapshot.savedAt < left.snapshot.savedAt ? -1
      : right.snapshot.savedAt > left.snapshot.savedAt ? 1
      : left.snapshot.artifactDigest < right.snapshot.artifactDigest ? -1 : 1)
    .slice(REVIEW_SNAPSHOT_LIMIT);
  for (const { path } of stale) {
    await unlink(resolve(store.runsRoot, runId, path)).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function listSnapshots(
  store: AtomicJsonStore,
  runId: string,
): Promise<{ path: string; snapshot: ReviewSnapshot }[]> {
  const paths = (await store.list(runId, REVIEW_SNAPSHOT_DIRECTORY))
    .filter((path) => path.endsWith(".json") && !path.split("/").pop()!.startsWith("."));
  const found: { path: string; snapshot: ReviewSnapshot }[] = [];
  for (const path of paths) {
    const parsed = reviewSnapshotSchema.safeParse(await store.read(runId, path));
    if (parsed.success) found.push({ path, snapshot: parsed.data });
  }
  return found;
}

/** The snapshot retained for an artifact digest, or null when there is none, or it is unreadable. */
export async function loadReviewSnapshot(
  store: AtomicJsonStore,
  changeName: string,
  artifactDigest: string,
): Promise<ReviewSnapshot | null> {
  if (!digest.safeParse(artifactDigest).success) return null;
  try {
    const parsed = reviewSnapshotSchema.safeParse(
      await store.read(changeRunId(changeName), snapshotPath(artifactDigest)),
    );
    return parsed.success && parsed.data.artifactDigest === artifactDigest ? parsed.data : null;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}
