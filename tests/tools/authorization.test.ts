import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { WriterLeaseRecord } from "../../src/execution/writer-lease.ts";
import {
  authorizeToolRequest,
  type AuthorizationContext,
} from "../../src/tools/authorization.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const parent = await mkdtemp(resolve(tmpdir(), "muster-authorization-"));
  temporaryDirectories.push(parent);
  const worktreePath = resolve(parent, "worktree");
  const outsidePath = resolve(parent, "outside");
  await mkdir(resolve(worktreePath, "src"), { recursive: true });
  await mkdir(outsidePath);
  await writeFile(resolve(worktreePath, "src", "file.ts"), "export {};\n");
  await writeFile(resolve(outsidePath, "secret.txt"), "secret\n");
  await symlink(outsidePath, resolve(worktreePath, "escape"), "dir");
  const lease: WriterLeaseRecord = {
    schemaVersion: 1,
    ownerId: randomUUID(),
    processId: process.pid,
    repositoryId: "repository-1",
    worktreePath,
    runId: "run-1",
    taskId: "7.2",
    command: "builder",
    acquiredAt: "2026-09-12T12:00:00.000Z",
  };
  const context: AuthorizationContext = {
    role: "builder",
    runId: "run-1",
    childId: "child-1",
    taskId: "7.2",
    taskState: "running",
    repositoryId: "repository-1",
    worktreePath,
    readScopes: ["src/**"],
    writeScopes: ["src/**"],
    writerLease: lease,
    now: () => new Date("2026-09-12T12:00:00.000Z"),
  };
  const request = (tool: string, targetPath: string) => ({
    tool,
    targetPath,
    correlationId: randomUUID(),
    requestBytes: 100,
  });
  return { context, request, worktreePath };
}

describe("tool authorization", () => {
  test("denies every reviewer mutation before filesystem access", async () => {
    const { context, request } = await fixture();
    for (const tool of ["apply_patch", "write_file", "serena_write", "command"]) {
      const decision = await authorizeToolRequest(
        { ...context, role: "reviewer", writerLease: null },
        request(tool, "src/file.ts"),
      );
      expect(decision.allowed).toBeFalse();
      expect(decision.reason).toContain("read-only");
      expect(decision.audit.decision).toBe("deny");
    }
  });

  test("allows scoped reads and writes with matching task and lease identity", async () => {
    const { context, request } = await fixture();
    const read = await authorizeToolRequest(context, request("read_file", "src/file.ts"));
    const write = await authorizeToolRequest(context, request("apply_patch", "src/file.ts"));

    expect(read.allowed).toBeTrue();
    expect(write.allowed).toBeTrue();
  });

  test("denies shell, traversal, symlink escape, and case aliases", async () => {
    const { context, request, worktreePath } = await fixture();
    await mkdir(resolve(worktreePath, "Source"));

    const decisions = await Promise.all([
      authorizeToolRequest(context, request("shell", worktreePath)),
      authorizeToolRequest(context, request("read_file", "../outside/secret.txt")),
      authorizeToolRequest(context, request("read_file", "escape/secret.txt")),
      authorizeToolRequest(context, request("read_file", "source/new.ts")),
    ]);

    expect(decisions.every((decision) => !decision.allowed)).toBeTrue();
    expect(decisions.map((decision) => decision.reason).join("\n")).toMatch(
      /shell access|escapes the worktree|resolves outside the worktree|casing differs/,
    );
  });

  test("denies writes without the exact running task lease", async () => {
    const { context, request, worktreePath } = await fixture();
    const outsideScope = await authorizeToolRequest(
      context,
      request("apply_patch", "README.md"),
    );
    const noLease = await authorizeToolRequest(
      { ...context, writerLease: null },
      request("apply_patch", "src/file.ts"),
    );
    const wrongTask = await authorizeToolRequest(
      { ...context, writerLease: { ...context.writerLease!, taskId: "other" } },
      request("serena_write", "src/file.ts"),
    );
    const stopped = await authorizeToolRequest(
      { ...context, taskState: "blocked" },
      request("command", worktreePath),
    );

    expect(outsideScope.reason).toContain("outside declared write scopes");
    expect(noLease.reason).toContain("matching active writer lease");
    expect(wrongTask.reason).toContain("matching active writer lease");
    expect(stopped.reason).toContain("running task");
  });

  test("allows only a running validator to submit non-filesystem gate evidence", async () => {
    const { context, request } = await fixture();
    const validator = await authorizeToolRequest(
      { ...context, role: "validator", writerLease: null },
      request("submit_gate", "."),
    );
    const builder = await authorizeToolRequest(context, request("submit_gate", "."));
    const architect = await authorizeToolRequest(
      { ...context, role: "architect", writerLease: null },
      request("submit_scope", "."),
    );

    expect(validator).toMatchObject({ allowed: true, capability: "evidence", canonicalPath: null });
    expect(architect).toMatchObject({ allowed: true, capability: "evidence", canonicalPath: null });
    expect(builder.reason).toContain("running evidence role");
  });
});