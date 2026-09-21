import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  FAILURE_EVIDENCE_MAX_BYTES,
  FAILURE_OUTPUT_TAIL_MAX_BYTES,
  failureBlock,
  latestFailure,
  recordFailure,
  type FailureInput,
} from "../../src/execution/recovery.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function store() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-recovery-"));
  roots.push(root);
  return { root, store: new AtomicJsonStore(resolve(root, "runs")) };
}

const failure = (attempt: number, overrides: Partial<FailureInput> = {}): FailureInput => ({
  attempt,
  outcome: "blocked",
  evidence: ["bun test tests/search.test.ts: exit 1"],
  reproduction: { command: "bun test tests/search.test.ts", exitCode: 1, output: "Expected 1, received 0" },
  changedPaths: ["src/search.ts"],
  recordedAt: `2026-09-21T10:0${attempt}:00.000Z`,
  ...overrides,
});

describe("failure records", () => {
  test("a verification failure holds the command, exit code, output tail and changed paths", async () => {
    const { store: s } = await store();
    await recordFailure(s, "add-search", "1.1", failure(1, { statedFix: "Moved the check" }));

    expect(await latestFailure(s, "add-search", "1.1")).toEqual({
      attempt: 1,
      outcome: "blocked",
      evidence: ["bun test tests/search.test.ts: exit 1"],
      reproduction: { command: "bun test tests/search.test.ts", exitCode: 1, outputTail: "Expected 1, received 0" },
      statedFix: "Moved the check",
      changedPaths: ["src/search.ts"],
      recordedAt: "2026-09-21T10:01:00.000Z",
    });
  });

  test("only the latest two are kept", async () => {
    const { root, store: s } = await store();
    for (const attempt of [1, 2, 3]) await recordFailure(s, "add-search", "1.1", failure(attempt));

    const file = JSON.parse(await readFile(resolve(root, "runs", "run-add-search", "failures", "1.1.json"), "utf8"));
    expect(file.failures.map((entry: { attempt: number }) => entry.attempt)).toEqual([2, 3]);
    expect((await latestFailure(s, "add-search", "1.1"))?.attempt).toBe(3);
  });

  test("evidence and the output tail are bounded, keeping the end of the output", async () => {
    const { store: s } = await store();
    const output = `${"x".repeat(5_000)}THE-END`;
    await recordFailure(s, "add-search", "1.1", failure(1, {
      evidence: ["é".repeat(3_000)],
      reproduction: { command: "bun test", exitCode: 1, output },
    }));

    const latest = (await latestFailure(s, "add-search", "1.1"))!;
    expect(Buffer.byteLength(latest.evidence[0]!)).toBeLessThanOrEqual(FAILURE_EVIDENCE_MAX_BYTES);
    expect(Buffer.byteLength(latest.reproduction!.outputTail)).toBeLessThanOrEqual(FAILURE_OUTPUT_TAIL_MAX_BYTES);
    expect(latest.reproduction!.outputTail.endsWith("THE-END")).toBe(true);
  });

  test("secrets are redacted before anything is written", async () => {
    const { root, store: s } = await store();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    await recordFailure(s, "add-search", "1.1", failure(1, {
      evidence: [`request failed with Authorization: Bearer ${secret}`],
      reproduction: { command: "bun test", exitCode: 1, output: `api_key=${secret}` },
      statedFix: `set password=${secret}`,
    }));

    const written = await readFile(resolve(root, "runs", "run-add-search", "failures", "1.1.json"), "utf8");
    expect(written).not.toContain(secret);
  });

  test("a task with no record, or an unreadable one, has no latest failure", async () => {
    const { store: s } = await store();
    expect(await latestFailure(s, "add-search", "9.9")).toBeNull();
  });

  test("a failure without a reproduction records none", async () => {
    const { store: s } = await store();
    await recordFailure(s, "add-search", "1.1", failure(1, { outcome: "error", reproduction: null }));
    expect((await latestFailure(s, "add-search", "1.1"))?.reproduction).toBeNull();
  });
});

describe("failureBlock", () => {
  test("is empty when there is no failure", () => {
    expect(failureBlock(null)).toBe("");
  });

  test("names the evidence, the reproduction and the previous attempt's paths", async () => {
    const { store: s } = await store();
    await recordFailure(s, "add-search", "1.1", failure(1, { statedFix: "Moved the check" }));
    const block = failureBlock(await latestFailure(s, "add-search", "1.1"));

    expect(block).toContain("attempt 1");
    expect(block).toContain("bun test tests/search.test.ts: exit 1");
    expect(block).toContain("Reproduce with: bun test tests/search.test.ts (exit 1)");
    expect(block).toContain("Expected 1, received 0");
    expect(block).toContain("Moved the check");
    expect(block).toContain("src/search.ts");
  });
});
