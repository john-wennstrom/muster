import { createHash } from "node:crypto";
import type { GitStatusEntry } from "./git.ts";

/**
 * These digests exist only to detect staleness (has anything changed since the
 * last observation?) — they are not content-addressable identifiers and do not
 * need to match any external hashing scheme.
 */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeIndexDigest(entries: readonly GitStatusEntry[]): string {
  const stable = [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => [entry.kind, entry.indexStatus, entry.worktreeStatus, entry.path, entry.originalPath ?? ""].join("\0"))
    .join("\n");
  return sha256(stable);
}

export function computeDiffDigest(diffText: string): string {
  return sha256(diffText);
}

export function computeSourceDigest(headCommit: string, diffText: string): string {
  return sha256(`${headCommit}\n${diffText}`);
}

/** Reads HEAD and the working diff from a repository and digests them together. */
export async function readSourceDigest(git: {
  head(): Promise<{ commit: string }>;
  diff(): Promise<string>;
}): Promise<{ head: string; diff: string; sourceDigest: string }> {
  const [head, diff] = await Promise.all([git.head(), git.diff()]);
  return { head: head.commit, diff, sourceDigest: computeSourceDigest(head.commit, diff) };
}
