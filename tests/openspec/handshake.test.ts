import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HarnessError } from "../../src/shared/errors.ts";
import {
  evaluateOpenSpecHandshake,
  requiredOpenSpecCapabilities,
  type OpenSpecHandshakeProbe,
} from "../../src/openspec/handshake.ts";

const fixtures = resolve(import.meta.dir, "../fixtures/openspec");

async function fixture(name: string): Promise<OpenSpecHandshakeProbe> {
  return JSON.parse(await readFile(resolve(fixtures, name), "utf8"));
}

describe("OpenSpec capability handshake", () => {
  test("accepts an unknown version when all machine capabilities are present", async () => {
    const result = evaluateOpenSpecHandshake(
      await fixture("handshake-compatible-unknown.json"),
    );

    expect(result.version).toBe("99.4.1-future");
    expect(result.capabilities).toEqual([...requiredOpenSpecCapabilities]);
    expect(result.diagnostics).toEqual([]);
  });

  test("rejects a missing required capability with remediation", async () => {
    const probe = await fixture("handshake-missing-capability.json");

    expect(() =>
      evaluateOpenSpecHandshake(probe),
    ).toThrow(
      expect.objectContaining({
        code: "OPENSPEC_CAPABILITY_MISSING",
        details: expect.objectContaining({
          missing: ["archive-json"],
        }),
      }) as HarnessError,
    );
  });
});