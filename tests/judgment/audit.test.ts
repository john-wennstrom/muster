import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import {
  createDecisionRecord,
  digestState,
  listDecisionRecords,
  reconcileDecisionRecord,
  summarizeDecisions,
  writeDecisionRecord,
  type DecisionRecord,
  type NewDecisionRecord,
} from "../../src/judgment/audit.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "judgment-audit-"));
  directories.push(root);
  return new AtomicJsonStore(root);
}

function input(overrides: Partial<NewDecisionRecord> = {}): NewDecisionRecord {
  return {
    decision: "test.sample",
    decisionVersion: 1,
    phase: "planning",
    mode: "shadow",
    status: "answered",
    unavailableReason: null,
    requestedModel: "jev-1.13.0",
    reportedModel: "jev-1.13.0",
    answers: {
      public_contract: { type: "noul", noul: 0.91 },
      disposition: {
        type: "choice",
        choice: "proceed",
        probabilities: { proceed: 0.9, clarify: 0.1 },
        confidence: 0.88,
      },
    },
    gate: { act: true, value: "escalate" },
    wouldHaveActed: true,
    acted: false,
    spend: { inputTokens: 1_000, outputTokens: 0, costUsd: 0.000042 },
    stateDigest: digestState("state"),
    ...overrides,
  };
}

const change = "judgment-layer";

describe("decision records", () => {
  test("round-trips every field the specification names", async () => {
    const store = await openStore();
    const record = createDecisionRecord(change, input());
    await writeDecisionRecord(store, change, record);

    const [read] = await listDecisionRecords(store, change);
    expect(read).toEqual(record);
    expect(read).toMatchObject({
      decision: "test.sample",
      decisionVersion: 1,
      mode: "shadow",
      requestedModel: "jev-1.13.0",
      reportedModel: "jev-1.13.0",
      wouldHaveActed: true,
      acted: false,
      spend: { inputTokens: 1_000, outputTokens: 0 },
      observed: {},
      agreement: null,
    });
    expect(read!.answers!.public_contract).toEqual({ type: "noul", noul: 0.91 });
    expect(read!.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("stores a digest and never the state", async () => {
    const store = await openStore();
    const record = createDecisionRecord(change, input({ stateDigest: digestState("SECRET-STATE-TEXT") }));
    await writeDecisionRecord(store, change, record);

    expect(JSON.stringify(await listDecisionRecords(store, change))).not.toContain("SECRET-STATE-TEXT");
  });

  test("records an unavailable result with its reason", async () => {
    const store = await openStore();
    await writeDecisionRecord(store, change, createDecisionRecord(change, input({
      status: "unavailable",
      unavailableReason: "model_mismatch",
      reportedModel: "jev-1.14.0",
      answers: null,
      gate: null,
      wouldHaveActed: false,
      spend: null,
    })));

    const [read] = await listDecisionRecords(store, change);
    expect(read).toMatchObject({
      status: "unavailable",
      unavailableReason: "model_mismatch",
      reportedModel: "jev-1.14.0",
    });
  });

  test("lists nothing for a change with no records", async () => {
    expect(await listDecisionRecords(await openStore(), change)).toEqual([]);
  });

  test("rejects a record that does not satisfy the schema", async () => {
    const store = await openStore();
    const record = { ...createDecisionRecord(change, input()), extra: true } as unknown as DecisionRecord;
    await expect(writeDecisionRecord(store, change, record)).rejects.toThrow();
  });
});

describe("reconciliation", () => {
  test("holds what the expensive stage concluded and whether it agreed", async () => {
    const store = await openStore();
    const record = createDecisionRecord(change, input());
    await writeDecisionRecord(store, change, record);

    const result = await reconcileDecisionRecord(store, change, record.recordId, {
      observed: { stageVerdict: "APPROVE" },
      agreed: true,
    });

    expect(result).toMatchObject({ found: true });
    const [read] = await listDecisionRecords(store, change);
    expect(read).toMatchObject({ observed: { stageVerdict: "APPROVE" }, agreement: true });
  });

  test("merges a second reconciliation without discarding the first", async () => {
    const store = await openStore();
    const record = createDecisionRecord(change, input());
    await writeDecisionRecord(store, change, record);

    await reconcileDecisionRecord(store, change, record.recordId, {
      observed: { stageVerdict: "APPROVE" },
      agreed: true,
    });
    await reconcileDecisionRecord(store, change, record.recordId, {
      observed: { findings: 0 },
      avoided: { activity: "review", totalTokens: 15_000, costUsd: 0.1 },
    });

    const [read] = await listDecisionRecords(store, change);
    expect(read).toMatchObject({
      observed: { stageVerdict: "APPROVE", findings: 0 },
      agreement: true,
      avoided: { activity: "review", totalTokens: 15_000, costUsd: 0.1 },
    });
  });

  test("reports a missing record without raising", async () => {
    const store = await openStore();
    expect(await reconcileDecisionRecord(store, change, "decision-missing", { agreed: true }))
      .toEqual({ found: false });
  });
});

describe("summaries", () => {
  function record(overrides: Partial<NewDecisionRecord> & { agreement?: boolean | null } = {}): DecisionRecord {
    const { agreement, ...rest } = overrides;
    return { ...createDecisionRecord(change, input(rest)), agreement: agreement ?? null };
  }

  test("separates would-have-acted from acted", () => {
    const [summary] = summarizeDecisions([
      record({ mode: "shadow", wouldHaveActed: true, acted: false }),
      record({ mode: "enforce", wouldHaveActed: true, acted: true }),
      record({ mode: "enforce", wouldHaveActed: false, acted: false, gate: { act: false, reason: "uncertain" } }),
    ]);

    expect(summary).toMatchObject({
      calls: 3,
      shadow: 1,
      enforced: 2,
      wouldHaveActed: 2,
      acted: 1,
    });
  });

  test("computes agreement over reconciled records only and reports how many", () => {
    const [summary] = summarizeDecisions([
      record({ agreement: true }),
      record({ agreement: false }),
      record({ agreement: true }),
      record({}),
      record({}),
    ]);

    expect(summary).toMatchObject({ calls: 5, reconciled: 3, agreed: 2 });
    expect(summary!.agreementRate).toBeCloseTo(2 / 3);
  });

  test("has no agreement rate when nothing is reconciled", () => {
    expect(summarizeDecisions([record({})])[0]!.agreementRate).toBeNull();
  });

  test("counts unavailable reasons and sums spend", () => {
    const [summary] = summarizeDecisions([
      record({}),
      record({ status: "unavailable", unavailableReason: "timeout", answers: null, gate: null, wouldHaveActed: false, spend: null }),
      record({ status: "unavailable", unavailableReason: "timeout", answers: null, gate: null, wouldHaveActed: false, spend: null }),
      record({ status: "unavailable", unavailableReason: "rate_limit", answers: null, gate: null, wouldHaveActed: false, spend: null }),
    ]);

    expect(summary).toMatchObject({
      calls: 4,
      unavailable: { timeout: 2, rate_limit: 1 },
      shadow: 1,
      spend: { inputTokens: 1_000 },
    });
  });

  test("counts avoided cost only where the decision acted", () => {
    const avoided = { activity: "review", totalTokens: 15_000, costUsd: 0.1 };
    const [summary] = summarizeDecisions([
      record({ mode: "enforce", acted: true, avoided }),
      record({ mode: "shadow", wouldHaveActed: true, acted: false, avoided }),
    ]);

    expect(summary!.avoided).toEqual({ totalTokens: 15_000, costUsd: 0.1 });
  });

  test("keeps each decision, and each version of it, separate", () => {
    const summaries = summarizeDecisions([
      record({ decision: "b.second" }),
      record({ decision: "a.first", decisionVersion: 2 }),
      record({ decision: "a.first", decisionVersion: 1 }),
      record({ decision: "a.first", decisionVersion: 1 }),
    ]);

    expect(summaries.map(({ decision, decisionVersion, calls }) => [decision, decisionVersion, calls]))
      .toEqual([["a.first", 1, 2], ["a.first", 2, 1], ["b.second", 1, 1]]);
  });

  test("an empty history summarizes to nothing", () => {
    expect(summarizeDecisions([])).toEqual([]);
  });
});
