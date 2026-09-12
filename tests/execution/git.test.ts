import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  GitAdapter,
  parseWorktreePorcelain,
} from "../../src/execution/git.ts";
import { runProcess } from "../../src/shared/process.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster git adapter "));
  temporaryDirectories.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "muster@example.invalid");
  await git(root, "config", "user.name", "Muster Tests");
  await writeFile(resolve(root, "tracked file.txt"), "initial\n");
  await git(root, "add", "tracked file.txt");
  await git(root, "commit", "-m", "initial");
  return root;
}

describe("Git adapter", () => {
  test("resolves repository identity through spaces and symlinks", async () => {
    const root = await repositoryFixture();
    const linkParent = await mkdtemp(resolve(tmpdir(), "muster-git-link-"));
    temporaryDirectories.push(linkParent);
    const link = resolve(linkParent, "linked repo");
    await symlink(root, link, "dir");

    const identity = await new GitAdapter(link).identity();

    expect(identity.root).toBe(root);
    expect(identity.commonDirectory).toBe(resolve(root, ".git"));
    expect(identity.id).toHaveLength(64);
  });

  test("reads detached HEAD, status, refs, diffs, and worktrees", async () => {
    const root = await repositoryFixture();
    const head = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "--detach", head);
    await writeFile(resolve(root, "tracked file.txt"), "changed\n");
    await writeFile(resolve(root, "untracked.txt"), "new\n");
    const adapter = new GitAdapter(root);

    expect(await adapter.head()).toEqual({ commit: head, branch: null });
    expect((await adapter.status()).map((entry) => entry.path).sort()).toEqual([
      "tracked file.txt",
      "untracked.txt",
    ]);
    expect(await adapter.diff()).toContain("changed");
    expect((await adapter.refs()).some((ref) => ref.name === "refs/heads/master" || ref.name === "refs/heads/main")).toBeTrue();
    expect(await adapter.worktrees()).toContainEqual(expect.objectContaining({
      path: root,
      head,
      detached: true,
    }));
  });

  test("parses native Windows worktree paths without colon splitting", () => {
    const records = parseWorktreePorcelain(
      "worktree C:\\Users\\Jane Doe\\repo\0HEAD abcdef1234567890\0branch refs/heads/main\0\0" +
      "worktree D:\\worktrees\\feature\0HEAD 0123456789abcdef\0detached\0locked reason with spaces\0\0",
    );

    expect(records).toEqual([
      {
        path: "C:\\Users\\Jane Doe\\repo",
        head: "abcdef1234567890",
        branch: "refs/heads/main",
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
      },
      {
        path: "D:\\worktrees\\feature",
        head: "0123456789abcdef",
        branch: null,
        detached: true,
        bare: false,
        locked: "reason with spaces",
        prunable: null,
      },
    ]);
  });
});