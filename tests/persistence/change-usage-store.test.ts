import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import {
  changeRunId,
  getActiveChange,
  listChangeUsage,
  loadChangeUsageSummary,
  recordChangeUsage,
  setActiveChange,
  summarizeChangeUsage,
} from "../../src/persistence/change-usage-store.ts";
import { createUsageRecord } from "../../src/telemetry/usage.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryStore() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-change-usage-"));
  temporaryDirectories.push(root);
  return new AtomicJsonStore(resolve(root, ".fusion/runs"));
}

function usage(overrides: Partial<Parameters<typeof createUsageRecord>[0]> = {}) {
  return createUsageRecord({
    runId: "run-add-search",
    phase: "planning",
    role: "architect",
    model: { provider: "openai", id: "gpt-5" },
    usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } },
    durationMs: 1_000,
    ...overrides,
  });
}

describe("change usage store", () => {
  test("derives a stable, filesystem-safe run id from a change name", () => {
    expect(changeRunId("Add Search")).toBe("run-add-search");
    expect(changeRunId("add-search")).toBe(changeRunId("Add Search"));
    expect(() => changeRunId("   ")).toThrow(HarnessError);
  });

  test("records and lists usage for a change", async () => {
    const store = await temporaryStore();
    await recordChangeUsage(store, "add-search", [usage(), usage({ phase: "implementation" })]);

    const records = await listChangeUsage(store, "add-search");
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.phase))).toEqual(new Set(["planning", "implementation"]));
  });

  test("summarizes usage by phase and total", () => {
    const records = [usage(), usage({ phase: "implementation" }), usage({ phase: "implementation" })];
    const summary = summarizeChangeUsage("add-search", records);

    expect(summary.total.invocations).toBe(3);
    expect(summary.byPhase.planning.invocations).toBe(1);
    expect(summary.byPhase.implementation.invocations).toBe(2);
    expect(summary.byPhase.validation.invocations).toBe(0);
  });

  test("loadChangeUsageSummary returns null when there is no recorded usage", async () => {
    const store = await temporaryStore();
    expect(await loadChangeUsageSummary(store, "add-search")).toBeNull();

    await recordChangeUsage(store, "add-search", [usage()]);
    const summary = await loadChangeUsageSummary(store, "add-search");
    expect(summary?.total.invocations).toBe(1);
  });

  test("tracks the active change across updates", async () => {
    const store = await temporaryStore();
    expect(await getActiveChange(store)).toBeNull();

    await setActiveChange(store, "add-search");
    expect(await getActiveChange(store)).toBe("add-search");

    await setActiveChange(store, "add-billing");
    expect(await getActiveChange(store)).toBe("add-billing");
  });
});
