import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ProcessRunner } from "../../src/shared/process.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../../src/tools/command-profile.ts";
import {
  prepareHostCommand,
  runHostCommand,
} from "../../src/tools/host-runner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const parent = await mkdtemp(resolve(tmpdir(), "muster-command-profile-"));
  temporaryDirectories.push(parent);
  const worktreePath = resolve(parent, "worktree");
  const sourcePath = resolve(worktreePath, "src");
  const outsidePath = resolve(parent, "outside");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(outsidePath);
  return { parent, worktreePath, sourcePath, outsidePath };
}

describe("command profiles", () => {
  test("prepares an argument-array command with a minimal environment", async () => {
    const { worktreePath, sourcePath } = await fixture();
    const command = await prepareHostCommand({
      worktreePath,
      request: {
        profile: "verification",
        executable: "bun",
        args: ["test", "tests/a file.test.ts", "&&", "echo"],
        cwd: sourcePath,
        timeoutMs: 5_000,
      },
      environment: {
        PATH: "/bin",
        HOME: "/home/test",
        API_TOKEN: "secret",
        SystemRoot: "C:\\Windows",
      },
    });

    expect(command.args).toEqual(["test", "tests/a file.test.ts", "&&", "echo"]);
    expect(command.env).toEqual({ PATH: "/bin", SystemRoot: "C:\\Windows" });
    expect(command.env).not.toHaveProperty("API_TOKEN");
    expect(command.env).not.toHaveProperty("HOME");
  });

  test("rejects unsupported profiles and direct shell escalation", async () => {
    const { worktreePath } = await fixture();
    const request = {
      executable: "bun",
      args: ["test"],
      cwd: worktreePath,
    };

    await expect(prepareHostCommand({
      worktreePath,
      request: { ...request, profile: "untrusted" },
    })).rejects.toMatchObject({ code: "COMMAND_PROFILE_UNKNOWN" });
    await expect(prepareHostCommand({
      worktreePath,
      request: { ...request, profile: "verification", executable: "bash" },
    })).rejects.toMatchObject({ code: "COMMAND_EXECUTABLE_DENIED" });
    await expect(prepareHostCommand({
      worktreePath,
      request: { ...request, profile: "verification", executable: "/usr/bin/bun" },
    })).rejects.toMatchObject({ code: "COMMAND_EXECUTABLE_DENIED" });
  });

  test("rejects working directories outside the worktree through paths or symlinks", async () => {
    const { worktreePath, outsidePath } = await fixture();
    const linkedPath = resolve(worktreePath, "linked-outside");
    await symlink(outsidePath, linkedPath, "dir");
    const request = {
      profile: "verification",
      executable: "bun",
      args: ["test"],
      cwd: outsidePath,
    };

    await expect(prepareHostCommand({ worktreePath, request })).rejects.toThrow(/inside the selected worktree/);
    await expect(prepareHostCommand({
      worktreePath,
      request: { ...request, cwd: linkedPath },
    })).rejects.toThrow(/inside the selected worktree/);
  });

  test("passes structured values to the runner without shell interpretation", async () => {
    const { worktreePath } = await fixture();
    const calls: unknown[][] = [];
    const runner: ProcessRunner = async (command, args, options) => {
      calls.push([command, args, options]);
      return {
        command,
        args,
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        durationMs: 1,
      };
    };

    const result = await runHostCommand({
      worktreePath,
      request: {
        profile: "verification",
        executable: "bun",
        args: ["test", "; rm -rf elsewhere"],
        cwd: worktreePath,
      },
      runner,
    });

    expect(result.stdout).toBe("ok");
    expect(calls[0]?.[0]).toBe("bun");
    expect(calls[0]?.[1]).toEqual(["test", "; rm -rf elsewhere"]);
    expect(HOST_EXECUTION_SECURITY_NOTICE).toContain("brokered and audited");
    expect(HOST_EXECUTION_SECURITY_NOTICE).toContain(
      "do not provide operating-system process or network isolation",
    );
    expect(HOST_EXECUTION_SECURITY_NOTICE).not.toMatch(/\bsandboxed\b/i);
  });
});