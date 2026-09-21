import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { GitAdapter, type GitStatusEntry } from "../execution/git.ts";
import { scopeMatches } from "../shared/scope.ts";

export interface RepositoryCommandSnapshot {
  head: string;
  status: readonly GitStatusEntry[];
  contentDigest: string;
}

export interface CommandScopeAudit {
  accepted: boolean;
  changedPaths: readonly string[];
  violations: readonly string[];
}

function statusKey(entry: GitStatusEntry): string {
  return `${entry.kind}\0${entry.indexStatus}\0${entry.worktreeStatus}\0${entry.path}\0${entry.originalPath ?? ""}`;
}

async function pathDigest(root: string, entries: readonly GitStatusEntry[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...new Set(entries.flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean) as string[]))].sort()) {
    hash.update(path).update("\0");
    try {
      const absolutePath = resolve(root, path);
      const stat = await lstat(absolutePath);
      hash.update(stat.isSymbolicLink() ? await readlink(absolutePath) : await readFile(absolutePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function captureRepositoryCommandSnapshot(
  worktreePath: string,
): Promise<RepositoryCommandSnapshot> {
  const git = new GitAdapter(worktreePath);
  const [head, status] = await Promise.all([git.head(), git.status()]);
  return {
    head: head.commit,
    status,
    contentDigest: await pathDigest(worktreePath, status),
  };
}

export function auditRepositoryCommand(
  before: RepositoryCommandSnapshot,
  after: RepositoryCommandSnapshot,
  allowedWriteScopes: readonly string[],
): CommandScopeAudit {
  const beforeStatus = new Map(before.status.map((entry) => [entry.path, statusKey(entry)]));
  const afterStatus = new Map(after.status.map((entry) => [entry.path, statusKey(entry)]));
  const candidates = new Set([...beforeStatus.keys(), ...afterStatus.keys()]);
  let changedPaths = [...candidates].filter((path) => beforeStatus.get(path) !== afterStatus.get(path));
  if (before.contentDigest !== after.contentDigest) changedPaths = [...candidates];
  changedPaths.sort();
  const violations = changedPaths
    .filter((path) => !allowedWriteScopes.some((scope) => scopeMatches(path.replaceAll("\\", "/"), scope)))
    .map((path) => `Command changed ${path} outside declared write scopes`);
  if (before.head !== after.head) violations.unshift("Command changed repository HEAD");
  return { accepted: violations.length === 0, changedPaths, violations };
}