import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runProcess } from "../../src/shared/process.ts";
import {
  runAuditedHostCommand,
  type StructuredCommandRequest,
} from "../../src/tools/host-runner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-host-runner-"));
  temporaryDirectories.push(root);
  await mkdir(resolve(root, "src"));
  await writeFile(resolve(root, "src", "allowed.txt"), "before\n");
  await writeFile(resolve(root, "README.md"), "before\n");
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
  const request = (script: string, timeoutMs = 5_000): StructuredCommandRequest => ({
    profile: "verification",
    executable: "node",
    args: ["-e", script],
    cwd: root,
    timeoutMs,
  });
  return { root, request };
}

describe("audited host command runner", () => {
  test("accepts in-scope changes and rejects out-of-scope changes as evidence", async () => {
    const { root, request } = await fixture();
    const allowed = await runAuditedHostCommand({
      worktreePath: root,
      request: request("require('fs').writeFileSync('src/allowed.txt', 'after\\n')"),
      allowedWriteScopes: ["src/**"],
    });
    expect(allowed.acceptedAsEvidence).toBeTrue();
    expect(allowed.audit.changedPaths).toEqual(["src/allowed.txt"]);

    const denied = await runAuditedHostCommand({
      worktreePath: root,
      request: request("require('fs').writeFileSync('README.md', 'after\\n')"),
      allowedWriteScopes: ["src/**"],
    });
    expect(denied.process.exitCode).toBe(0);
    expect(denied.acceptedAsEvidence).toBeFalse();
    expect(denied.audit.violations).toEqual([
      "Command changed README.md outside declared write scopes",
    ]);
  });

  test("blocks destructive Git before execution", async () => {
    const { root } = await fixture();
    await expect(runAuditedHostCommand({
      worktreePath: root,
      request: {
        profile: "verification",
        executable: "git",
        args: ["push", "--force", "origin", "main"],
        cwd: root,
      },
      allowedWriteScopes: ["src/**"],
    })).rejects.toMatchObject({
      code: "HOST_COMMAND_PROHIBITED",
      details: { category: "destructive" },
    });
  });

  test("terminates output flooding and timeout", async () => {
    const { root, request } = await fixture();
    await expect(runAuditedHostCommand({
      worktreePath: root,
      request: request("process.stdout.write('x'.repeat(10000))"),
      allowedWriteScopes: ["src/**"],
      maxOutputBytes: 100,
    })).rejects.toMatchObject({ code: "HOST_COMMAND_OUTPUT_LIMIT" });

    await expect(runAuditedHostCommand({
      worktreePath: root,
      request: request("setTimeout(() => {}, 10000)", 10),
      allowedWriteScopes: ["src/**"],
    })).rejects.toMatchObject({ code: "HOST_COMMAND_TIMEOUT" });
  });

  test("honors cancellation before spawn", async () => {
    const { root, request } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(runAuditedHostCommand({
      worktreePath: root,
      request: request("process.stdout.write('should not run')"),
      allowedWriteScopes: ["src/**"],
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "HOST_COMMAND_CANCELLED" });
  });
});