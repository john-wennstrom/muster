import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runProcess } from "../../src/shared/process.ts";
import type { JudgmentRuntime, JudgmentVerdict } from "../../src/judgment/ask.ts";
import { abstain, act, type CommandGateValue } from "../../src/judgment/gates.ts";
import {
  runAuditedHostCommand,
  type HostCommandAuditEvent,
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
function judgmentDouble(verdict: JudgmentVerdict<CommandGateValue>) {
  const calls: unknown[] = [];
  const runtime = {
    enabled: true,
    async askJev() { throw new Error("unused"); },
    async judge(_decision: unknown, request: unknown) {
      calls.push(request);
      return verdict;
    },
  } as unknown as JudgmentRuntime;
  return { runtime, calls, options: { runtime, changeName: "change-1", taskId: "1.1" } };
}

describe("audited host command runner with judgment", () => {
  const touch = "require('fs').writeFileSync('src/allowed.txt', 'ran\\n')";

  test("a judged category denies a command the rules allow, before it starts", async () => {
    const { root, request } = await fixture();
    const events: HostCommandAuditEvent[] = [];
    const { options, calls } = judgmentDouble({
      kind: "enforce",
      outcome: act({ category: "external_side_effect", confidence: 0.55 }),
      recordId: "record-1",
    });
    await expect(runAuditedHostCommand({
      worktreePath: root,
      request: request(touch),
      allowedWriteScopes: ["src/**"],
      judgment: options,
      onAudit: (event) => { events.push(event); },
    })).rejects.toMatchObject({
      code: "HOST_COMMAND_PROHIBITED",
      details: { category: "external_side_effect", source: "judgment", confidence: 0.55 },
    });
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      decision: "deny",
      code: "HOST_COMMAND_PROHIBITED",
      judged: { category: "external_side_effect", confidence: 0.55 },
    });
    expect(await Bun.file(resolve(root, "src", "allowed.txt")).text()).toBe("before\n");
  });

  test("a rule denial is unchanged and never judged", async () => {
    const { root } = await fixture();
    const events: HostCommandAuditEvent[] = [];
    const { options, calls } = judgmentDouble({ kind: "enforce", outcome: abstain("none"), recordId: null });
    await expect(runAuditedHostCommand({
      worktreePath: root,
      request: { profile: "verification", executable: "git", args: ["push", "--force"], cwd: root },
      allowedWriteScopes: ["src/**"],
      judgment: options,
      onAudit: (event) => { events.push(event); },
    })).rejects.toMatchObject({ code: "HOST_COMMAND_PROHIBITED", details: { category: "destructive" } });
    expect(calls).toHaveLength(0);
    expect(events[0]!.judged).toBeUndefined();
  });

  test("a profile refusal comes before judgment, so nothing is sent", async () => {
    const { root } = await fixture();
    const { options, calls } = judgmentDouble({
      kind: "enforce",
      outcome: act({ category: "destructive", confidence: 1 }),
      recordId: null,
    });
    await expect(runAuditedHostCommand({
      worktreePath: root,
      request: { profile: "verification", executable: "curl", args: ["example.invalid"], cwd: root },
      allowedWriteScopes: ["src/**"],
      judgment: options,
    })).rejects.toMatchObject({ code: "COMMAND_EXECUTABLE_DENIED" });
    expect(calls).toHaveLength(0);
  });

  test("none and unavailable judgments run the command as they do without judgment", async () => {
    for (const verdict of [
      { kind: "enforce", outcome: abstain("none"), recordId: null },
      { kind: "fallback", reason: "timeout", recordId: null },
    ] as const) {
      const { root, request } = await fixture();
      const { options } = judgmentDouble(verdict);
      const result = await runAuditedHostCommand({
        worktreePath: root,
        request: request(touch),
        allowedWriteScopes: ["src/**"],
        judgment: options,
      });
      expect(result.acceptedAsEvidence).toBeTrue();
      expect(result.audit.changedPaths).toEqual(["src/allowed.txt"]);
    }
  });

  test("shadow judgment never blocks", async () => {
    const { root, request } = await fixture();
    const { options, calls } = judgmentDouble({ kind: "shadow", recordId: "record-1" });
    const result = await runAuditedHostCommand({
      worktreePath: root,
      request: request(touch),
      allowedWriteScopes: ["src/**"],
      judgment: options,
    });
    expect(calls).toHaveLength(1);
    expect(result.acceptedAsEvidence).toBeTrue();
  });

  test("a judged category does not relax the write-scope audit of a command that runs", async () => {
    const { root, request } = await fixture();
    const { options } = judgmentDouble({ kind: "enforce", outcome: abstain("none"), recordId: null });
    const result = await runAuditedHostCommand({
      worktreePath: root,
      request: request("require('fs').writeFileSync('README.md', 'after\\n')"),
      allowedWriteScopes: ["src/**"],
      judgment: options,
    });
    expect(result.acceptedAsEvidence).toBeFalse();
  });

  test("the command's working directory is sent relative to the worktree", async () => {
    const { root, request } = await fixture();
    const { options, calls } = judgmentDouble({ kind: "enforce", outcome: abstain("none"), recordId: null });
    await runAuditedHostCommand({
      worktreePath: root,
      request: { ...request("0"), cwd: resolve(root, "src") },
      allowedWriteScopes: ["src/**"],
      judgment: options,
    });
    expect((calls[0] as { state: { cwd: string } }).state.cwd).toBe("src");
  });
});
