import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../shared/process.ts";
import { HarnessError } from "../shared/errors.ts";

export interface GitIdentity {
  id: string;
  root: string;
  commonDirectory: string;
}

export interface GitHead {
  commit: string;
  branch: string | null;
}

export interface GitStatusEntry {
  kind: "ordinary" | "renamed" | "untracked" | "ignored" | "unmerged";
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath?: string;
}

export interface GitRef {
  name: string;
  object: string;
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
}

function invalidOutput(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("GIT_OUTPUT_INVALID", message, details);
}

function splitFields(value: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const separator = value.indexOf(" ", offset);
    if (separator === -1) return invalidOutput("Git porcelain record has too few fields", { value, count });
    fields.push(value.slice(offset, separator));
    offset = separator + 1;
  }
  return { fields, rest: value.slice(offset) };
}

export function parseStatusPorcelain(output: string): GitStatusEntry[] {
  const records = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (!record) continue;
    const prefix = record[0];
    if (prefix === "?" || prefix === "!") {
      entries.push({
        kind: prefix === "?" ? "untracked" : "ignored",
        indexStatus: prefix,
        worktreeStatus: prefix,
        path: record.slice(2),
      });
      continue;
    }
    if (prefix === "1" || prefix === "u") {
      const { fields, rest } = splitFields(record, prefix === "1" ? 8 : 10);
      const status = fields[1] ?? "..";
      entries.push({
        kind: prefix === "1" ? "ordinary" : "unmerged",
        indexStatus: status[0] ?? ".",
        worktreeStatus: status[1] ?? ".",
        path: rest,
      });
      continue;
    }
    if (prefix === "2") {
      const { fields, rest } = splitFields(record, 9);
      const originalPath = records[++index];
      if (originalPath === undefined) return invalidOutput("Renamed Git record has no original path", { record });
      const status = fields[1] ?? "..";
      entries.push({
        kind: "renamed",
        indexStatus: status[0] ?? ".",
        worktreeStatus: status[1] ?? ".",
        path: rest,
        originalPath,
      });
      continue;
    }
    if (prefix === "#") continue;
    invalidOutput("Unknown Git status porcelain record", { record });
  }
  return entries;
}

export function parseWorktreePorcelain(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const record of output.split("\0")) {
    if (!record) {
      if (current) {
        worktrees.push(current);
        current = undefined;
      }
      continue;
    }
    const separator = record.indexOf(" ");
    const key = separator === -1 ? record : record.slice(0, separator);
    const value = separator === -1 ? "" : record.slice(separator + 1);
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
      };
      continue;
    }
    if (!current) return invalidOutput("Git worktree field appears before worktree path", { record });
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.locked = value;
    else if (key === "prunable") current.prunable = value;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export class GitAdapter {
  constructor(
    readonly cwd: string,
    private readonly runner: ProcessRunner = runProcess,
    private readonly timeoutMs = 10_000,
    private readonly signal?: AbortSignal,
  ) {}

  private async command(args: readonly string[], allowFailure = false): Promise<ProcessResult> {
    const result = await this.runner("git", args, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      signal: this.signal,
    });
    if (!allowFailure && result.exitCode !== 0) {
      throw new HarnessError(
        "GIT_COMMAND_FAILED",
        `git ${args.join(" ")} failed with exit ${result.exitCode}`,
        { args, cwd: this.cwd, exitCode: result.exitCode, stderr: result.stderr.trim() },
      );
    }
    return result;
  }

  async identity(): Promise<GitIdentity> {
    const result = await this.command([
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length !== 2) return invalidOutput("Git repository identity returned unexpected paths", { lines });
    const root = await realpath(isAbsolute(lines[0]!) ? lines[0]! : resolve(this.cwd, lines[0]!));
    const commonDirectory = await realpath(isAbsolute(lines[1]!) ? lines[1]! : resolve(this.cwd, lines[1]!));
    const id = createHash("sha256").update(commonDirectory, "utf8").digest("hex");
    return { id, root, commonDirectory };
  }

  async head(): Promise<GitHead> {
    const commit = (await this.command(["rev-parse", "--verify", "HEAD"])).stdout.trim();
    if (!commit) return invalidOutput("Git HEAD commit is empty", { cwd: this.cwd });
    const branchResult = await this.command(["symbolic-ref", "--quiet", "--short", "HEAD"], true);
    return {
      commit,
      branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null,
    };
  }

  async status(): Promise<GitStatusEntry[]> {
    return parseStatusPorcelain((await this.command([
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ])).stdout);
  }

  /** Tracked and non-ignored untracked files, repository-relative with forward slashes, sorted. */
  async listFiles(): Promise<string[]> {
    const output = (await this.command([
      "--literal-pathspecs",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])).stdout;
    return [...new Set(output.split("\0").filter(Boolean))].sort();
  }

  async refs(): Promise<GitRef[]> {
    const output = (await this.command([
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
    ])).stdout;
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const separator = line.indexOf("\0");
      if (separator === -1) return invalidOutput("Git ref record has no NUL separator", { line });
      return { name: line.slice(0, separator), object: line.slice(separator + 1) };
    });
  }

  async diff(): Promise<string> {
    return (await this.command([
      "diff",
      "--no-ext-diff",
      "--binary",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ])).stdout;
  }

  async worktrees(): Promise<GitWorktree[]> {
    const worktrees = parseWorktreePorcelain((await this.command([
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ])).stdout);
    return Promise.all(worktrees.map(async (worktree) => ({
      ...worktree,
      path: await realpath(worktree.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return resolve(worktree.path);
        throw error;
      }),
    })));
  }
}
