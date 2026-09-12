import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import { HarnessError } from "../../src/shared/errors.ts";
import type { ProcessResult, ProcessRunOptions } from "../../src/shared/process.ts";

const fixtures = resolve(import.meta.dir, "../fixtures/openspec");
const cwd = "/workspace/project";

function result(
  args: readonly string[],
  stdout = "",
  stderr = "",
  exitCode = 0,
): ProcessResult {
  return {
    command: "openspec",
    args,
    exitCode,
    signal: null,
    stdout,
    stderr,
    durationMs: 1,
  };
}

describe("OpenSpec adapter", () => {
  test("uses typed JSON commands with explicit cwd and timeout", async () => {
    const fixture = JSON.parse(
      await readFile(resolve(fixtures, "protocol-valid.json"), "utf8"),
    ) as Record<string, unknown>;
    const calls: Array<{ args: readonly string[]; options: ProcessRunOptions }> = [];
    const runner = async (
      _command: string,
      args: readonly string[],
      options: ProcessRunOptions,
    ): Promise<ProcessResult> => {
      calls.push({ args, options });
      const key = args.join(" ");
      if (key === "--version") return result(args, "99.0.0\n");
      if (key === "context --json") return result(args, JSON.stringify(fixture.context));
      if (key.endsWith("--help")) {
        const help = key.startsWith("status")
          ? "status --change <id> --json"
          : key.startsWith("instructions")
            ? "instructions [artifact|apply|archive] --change <id> --json"
            : `${args[0]} --json`;
        return result(args, help);
      }
      if (key === "status --change add-search --json") return result(args, JSON.stringify(fixture.status));
      if (key === "instructions tasks --change add-search --json") return result(args, JSON.stringify(fixture.instructions));
      if (key === "instructions apply --change add-search --json") return result(args, JSON.stringify(fixture.apply));
      if (key === "validate add-search --type change --strict --json") return result(args, JSON.stringify(fixture.validate));
      if (key === "archive add-search --json --yes") return result(args, JSON.stringify(fixture.archive));
      return result(args, "", `unexpected command: ${key}`, 2);
    };
    const adapter = new OpenSpecAdapter({ cwd, timeoutMs: 3_000, runner });

    expect((await adapter.detect()).version).toBe("99.0.0");
    expect((await adapter.status("add-search")).changeName).toBe("add-search");
    expect((await adapter.instructions("tasks", "add-search")).artifactId).toBe("proposal");
    expect((await adapter.applyInstructions("add-search")).state).toBe("ready");
    expect((await adapter.validate("add-search")).items[0]?.valid).toBeTrue();
    expect((await adapter.archive("add-search")).archive.change).toBe("add-search");

    expect(calls.every((call) => call.options.cwd === cwd)).toBeTrue();
    expect(calls.every((call) => call.options.timeoutMs === 3_000)).toBeTrue();
    expect(calls.map((call) => call.args)).toContainEqual([
      "archive",
      "add-search",
      "--json",
      "--yes",
    ]);
  });

  test("reports nonzero exits with stderr and command context", async () => {
    const adapter = new OpenSpecAdapter({
      cwd,
      runner: async (_command, args) => result(args, "", "change missing", 2),
    });

    try {
      await adapter.status("missing");
      throw new Error("status unexpectedly passed");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe("OPENSPEC_COMMAND_FAILED");
      expect((error as HarnessError).details.stderr).toBe("change missing");
    }
  });

  test("rejects incompatible payloads", async () => {
    const adapter = new OpenSpecAdapter({
      cwd,
      runner: async (_command, args) => result(args, "{\"changeName\":42}"),
    });

    await expect(adapter.status("broken")).rejects.toMatchObject({
      code: "OPENSPEC_SCHEMA_MISMATCH",
    });
  });

  test("forwards cancellation to the process runner", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new OpenSpecAdapter({
      cwd,
      signal: controller.signal,
      runner: async (_command, _args, options) => {
        if (options.signal?.aborted) {
          throw new HarnessError("PROCESS_CANCELLED", "cancelled");
        }
        throw new Error("missing abort signal");
      },
    });

    await expect(adapter.status("cancelled")).rejects.toMatchObject({
      code: "PROCESS_CANCELLED",
    });
  });
});