import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HarnessError } from "../../src/shared/errors.ts";
import { runProcess } from "../../src/shared/process.ts";
import { openSpecSchemas, parseOpenSpecJson } from "../../src/openspec/protocol.ts";

const fixtures = resolve(import.meta.dir, "../fixtures/openspec");

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(fixtures, name), "utf8"));
}

describe("OpenSpec protocol schemas", () => {
  test("accepts representative structured payloads", async () => {
    const valid = await fixture("protocol-valid.json");

    for (const [name, schema] of Object.entries(openSpecSchemas)) {
      expect(() => parseOpenSpecJson(name, JSON.stringify(valid[name]), schema)).not.toThrow();
    }
  });

  test("rejects malformed JSON with a structured error", () => {
    expect(() => parseOpenSpecJson("status", "{", openSpecSchemas.status)).toThrow(
      expect.objectContaining({ code: "OPENSPEC_INVALID_JSON" }),
    );
  });

  test("rejects incompatible fields with path-specific diagnostics", async () => {
    const invalid = await fixture("protocol-invalid.json");

    for (const [name, schema] of Object.entries(openSpecSchemas)) {
      try {
        parseOpenSpecJson(name, JSON.stringify(invalid[name]), schema);
        throw new Error(`${name} fixture unexpectedly passed`);
      } catch (error) {
        expect(error).toBeInstanceOf(HarnessError);
        expect((error as HarnessError).code).toBe("OPENSPEC_SCHEMA_MISMATCH");
        expect((error as HarnessError).details.issues).toBeArray();
        expect((error as HarnessError).message).toContain(name);
      }
    }
  });
});

describe("process runner", () => {
  test("captures stdout, stderr, and nonzero exit status separately", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
      { cwd: fixtures, timeoutMs: 5_000 },
    );

    expect(result).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err" });
  });

  test("cancels an active child with a structured error", async () => {
    const controller = new AbortController();
    const pending = runProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: fixtures, timeoutMs: 5_000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);

    try {
      await pending;
      throw new Error("process unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe("PROCESS_CANCELLED");
    }
  });
});