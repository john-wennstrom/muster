import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { GitAdapter } from "./git.ts";
import { runProcess, type ProcessRunner } from "../shared/process.ts";
import { HarnessError } from "../shared/errors.ts";

export interface EnsureChangeWorktreeOptions {
  planningCwd: string;
  changeName: string;
  worktreesRoot: string;
  recordedPath?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChangeWorktree {
  repositoryId: string;
  commonDirectory: string;
  path: string;
  branch: string;
  head: string;
  reused: boolean;
}

function unsafe(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("WORKTREE_UNSAFE", message, details);
}

function changeSlug(changeName: string): string {
  const slug = changeName.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return unsafe("Change name cannot produce a safe worktree identifier", { changeName });
  return slug;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureChangeWorktree(
  options: EnsureChangeWorktreeOptions,
): Promise<ChangeWorktree> {
  const runner = options.runner ?? runProcess;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const planningGit = new GitAdapter(options.planningCwd, runner, timeoutMs, options.signal);
  const identity = await planningGit.identity();
  const planningHead = await planningGit.head();
  const slug = changeSlug(options.changeName);
  const branch = `muster/${slug}`;
  const targetPath = resolve(options.worktreesRoot, slug);
  const canonicalTargetPath = await canonicalizePath(targetPath);
  if (options.recordedPath && pathKey(await canonicalizePath(options.recordedPath)) !== pathKey(canonicalTargetPath)) {
    return unsafe("Recorded worktree path does not match deterministic selection", {
      recordedPath: options.recordedPath,
      targetPath,
    });
  }

  const worktrees = await planningGit.worktrees();
  const existing = worktrees.find((worktree) => pathKey(worktree.path) === pathKey(canonicalTargetPath));
  if (existing) {
    if (existing.branch !== `refs/heads/${branch}` || !existing.head) {
      return unsafe("Existing worktree does not match the change branch", {
        targetPath,
        expectedBranch: `refs/heads/${branch}`,
        existing,
      });
    }
    const canonicalPath = await realpath(existing.path);
    const selectedIdentity = await new GitAdapter(canonicalPath, runner, timeoutMs, options.signal).identity();
    if (selectedIdentity.id !== identity.id) {
      return unsafe("Existing worktree belongs to a different repository", {
        targetPath,
        expectedRepositoryId: identity.id,
        repositoryId: selectedIdentity.id,
      });
    }
    return {
      repositoryId: identity.id,
      commonDirectory: identity.commonDirectory,
      path: canonicalPath,
      branch,
      head: existing.head,
      reused: true,
    };
  }

  if (await pathExists(targetPath)) {
    return unsafe("Deterministic worktree path exists but is not registered with Git", {
      targetPath,
    });
  }
  await mkdir(options.worktreesRoot, { recursive: true });
  const branchExists = (await planningGit.refs()).some((ref) => ref.name === `refs/heads/${branch}`);
  const args = branchExists
    ? ["worktree", "add", targetPath, branch]
    : ["worktree", "add", "-b", branch, targetPath, planningHead.commit];
  const result = await runner("git", args, {
    cwd: identity.root,
    timeoutMs,
    signal: options.signal,
  });
  if (result.exitCode !== 0) {
    return unsafe("Git could not create the change worktree", {
      targetPath,
      branch,
      exitCode: result.exitCode,
      stderr: result.stderr.trim(),
    });
  }

  const canonicalPath = await realpath(targetPath);
  const selectedHead = await new GitAdapter(canonicalPath, runner, timeoutMs, options.signal).head();
  return {
    repositoryId: identity.id,
    commonDirectory: identity.commonDirectory,
    path: canonicalPath,
    branch,
    head: selectedHead.commit,
    reused: false,
  };
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

async function canonicalizePath(path: string): Promise<string> {
  return realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return resolve(path);
    throw error;
  });
}
