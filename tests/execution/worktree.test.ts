import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensureChangeWorktree } from "../../src/execution/worktree.ts";
import { runProcess } from "../../src/shared/process.ts";
import { HarnessError } from "../../src/shared/errors.ts";

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
  const parent = await mkdtemp(resolve(tmpdir(), "muster-worktree-"));
  temporaryDirectories.push(parent);
  const root = resolve(parent, "planning repo");
  await mkdir(root);
  await git(root, "init");
  await git(root, "config", "user.email", "muster@example.invalid");
  await git(root, "config", "user.name", "Muster Tests");
  await writeFile(resolve(root, "source.txt"), "committed\n");
  await git(root, "add", "source.txt");
  await git(root, "commit", "-m", "initial");
  return { parent, root };
}

describe("change worktree manager", () => {
  test("creates implementation worktree from HEAD without dirty planning changes", async () => {
    const { parent, root } = await repositoryFixture();
    await writeFile(resolve(root, "source.txt"), "dirty planning edit\n");

    const selected = await ensureChangeWorktree({
      planningCwd: root,
      changeName: "Add Search",
      worktreesRoot: resolve(parent, "worktrees"),
    });

    expect(selected.reused).toBeFalse();
    expect(selected.branch).toBe("muster/add-search");
    expect(await readFile(resolve(selected.path, "source.txt"), "utf8")).toBe("committed\n");
    expect(await readFile(resolve(root, "source.txt"), "utf8")).toBe("dirty planning edit\n");
  });

  test("safely reuses the matching registered worktree", async () => {
    const { parent, root } = await repositoryFixture();
    const options = {
      planningCwd: root,
      changeName: "add-search",
      worktreesRoot: resolve(parent, "worktrees"),
    };

    const created = await ensureChangeWorktree(options);
    const reused = await ensureChangeWorktree({ ...options, recordedPath: created.path });

    expect(reused).toEqual({ ...created, reused: true });
  });

  test("rejects an occupied target that is not a registered worktree", async () => {
    const { parent, root } = await repositoryFixture();
    const worktreesRoot = resolve(parent, "worktrees");
    await mkdir(resolve(worktreesRoot, "add-search"), { recursive: true });

    await expect(ensureChangeWorktree({
      planningCwd: root,
      changeName: "add-search",
      worktreesRoot,
    })).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" } as HarnessError);
  });
});