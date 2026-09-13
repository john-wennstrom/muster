import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { WriterLeaseRecord } from "../../src/execution/writer-lease.ts";
import { runProcess } from "../../src/shared/process.ts";
import { authorizeToolRequest } from "../../src/tools/authorization.ts";
import { prepareHostCommand, runAuditedHostCommand } from "../../src/tools/host-runner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const parent = await mkdtemp(resolve(tmpdir(), "muster-security-"));
  temporaryDirectories.push(parent);
  const root = resolve(parent, "repo");
  const outside = resolve(parent, "outside");
  await mkdir(resolve(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(resolve(root, "src", "allowed.txt"), "before\n");
  await writeFile(resolve(root, "README.md"), "before\n");
  await writeFile(resolve(outside, "secret.txt"), "secret\n");
  await symlink(outside, resolve(root, "escape"), "dir");
  for (const args of [
    ["init"],
    ["config", "user.email", "muster@example.invalid"],
    ["config", "user.name", "Muster Tests"],
    ["add", "."],
    ["commit", "-m", "initial"],
  ]) {
    const result = await runProcess("git", args, { cwd: root, timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  const lease: WriterLeaseRecord = {
    schemaVersion: 1,
    ownerId: randomUUID(),
    processId: process.pid,
    repositoryId: "repository-1",
    worktreePath: root,
    runId: "run-1",
    taskId: "7.7",
    command: "builder",
    acquiredAt: "2026-09-12T12:00:00.000Z",
  };
  return { parent, root, outside, lease };
}

describe("adversarial broker and host runner", () => {
  test("rejects traversal, symlink escape, and out-of-scope mutation", async () => {
    const { root, lease } = await fixture();
    const context = {
      role: "builder" as const,
      runId: "run-1",
      childId: "child-1",
      taskId: "7.7",
      taskState: "running" as const,
      repositoryId: "repository-1",
      worktreePath: root,
      readScopes: ["src/**"],
      writeScopes: ["src/**"],
      writerLease: lease,
    };
    const request = (path: string) => ({
      tool: "write_file",
      targetPath: path,
      correlationId: randomUUID(),
      requestBytes: 100,
    });

    expect((await authorizeToolRequest(context, request("../outside/secret.txt"))).audit.decision).toBe("deny");
    expect((await authorizeToolRequest(context, request("escape/secret.txt"))).audit.decision).toBe("deny");
    expect((await authorizeToolRequest(context, request("README.md"))).audit.decision).toBe("deny");
  });

  test("strips secret environment and rejects shell escalation", async () => {
    const { root } = await fixture();
    const prepared = await prepareHostCommand({
      worktreePath: root,
      request: { profile: "verification", executable: "node", args: ["--version"], cwd: root },
      environment: { PATH: "/bin", API_TOKEN: "secret", HOME: "/secret-home" },
    });
    expect(prepared.env).toEqual({ PATH: "/bin" });
    const audits: string[] = [];
    await expect(runAuditedHostCommand({
      worktreePath: root,
      request: { profile: "verification", executable: "bash", args: ["-c", "echo unsafe"], cwd: root },
      allowedWriteScopes: ["src/**"],
      onAudit: (event) => { audits.push(`${event.decision}:${event.code}`); },
    })).rejects.toMatchObject({ code: "COMMAND_EXECUTABLE_DENIED" });
    expect(audits).toEqual(["deny:COMMAND_EXECUTABLE_DENIED"]);
  });

  test("blocks prohibited and unauthorized Git before execution", async () => {
    const { root } = await fixture();
    const audits: string[] = [];
    const command = (args: string[]) => runAuditedHostCommand({
      worktreePath: root,
      request: { profile: "verification", executable: "git", args, cwd: root },
      allowedWriteScopes: ["src/**"],
      onAudit: (event) => { audits.push(`${event.decision}:${event.code}`); },
    });

    await expect(command(["push", "--force", "origin", "main"])).rejects.toMatchObject({
      code: "HOST_COMMAND_PROHIBITED",
      details: { audit: { decision: "deny" } },
    });
    await expect(command(["commit", "--allow-empty", "-m", "unauthorized"])).rejects.toMatchObject({
      code: "HOST_COMMAND_GIT_DENIED",
      details: { audit: { decision: "deny" } },
    });
    expect(audits).toEqual([
      "deny:HOST_COMMAND_PROHIBITED",
      "deny:HOST_COMMAND_GIT_DENIED",
    ]);
  });

  test("rejects out-of-scope diffs even when the process exits successfully", async () => {
    const { root } = await fixture();
    const audits: string[] = [];
    const result = await runAuditedHostCommand({
      worktreePath: root,
      request: {
        profile: "verification",
        executable: "node",
        args: ["-e", "require('fs').writeFileSync('README.md', 'changed\\n')"],
        cwd: root,
      },
      allowedWriteScopes: ["src/**"],
      onAudit: (event) => { audits.push(`${event.decision}:${event.code}`); },
    });

    expect(result.process.exitCode).toBe(0);
    expect(result.acceptedAsEvidence).toBeFalse();
    expect(result.audit.violations).toEqual(["Command changed README.md outside declared write scopes"]);
    expect(await readFile(resolve(root, "README.md"), "utf8")).toBe("changed\n");
    expect(audits).toEqual(["reject:HOST_COMMAND_EVIDENCE_REJECTED"]);
  });

  test("terminates output flooding, timeout, and cancellation", async () => {
    const { root } = await fixture();
    const audits: string[] = [];
    const run = (script: string, timeoutMs = 5_000, signal?: AbortSignal) => runAuditedHostCommand({
      worktreePath: root,
      request: { profile: "verification", executable: "node", args: ["-e", script], cwd: root, timeoutMs },
      allowedWriteScopes: ["src/**"],
      maxOutputBytes: 64,
      signal,
      onAudit: (event) => { audits.push(`${event.decision}:${event.code}`); },
    });
    await expect(run("process.stdout.write('x'.repeat(1000))")).rejects.toMatchObject({ code: "HOST_COMMAND_OUTPUT_LIMIT" });
    await expect(run("setTimeout(() => {}, 10000)", 10)).rejects.toMatchObject({ code: "HOST_COMMAND_TIMEOUT" });
    const controller = new AbortController();
    controller.abort();
    await expect(run("process.stdout.write('no')", 5_000, controller.signal)).rejects.toMatchObject({ code: "HOST_COMMAND_CANCELLED" });
    expect(audits).toEqual([
      "reject:HOST_COMMAND_OUTPUT_LIMIT",
      "reject:HOST_COMMAND_TIMEOUT",
      "reject:HOST_COMMAND_CANCELLED",
    ]);
  });
});