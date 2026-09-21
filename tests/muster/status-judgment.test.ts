import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ChangeSnapshot } from "../../src/controller/change-snapshot.ts";
import { createDecisionRecord, writeDecisionRecord } from "../../src/judgment/audit.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { runProductionStatus } from "../../src/change/phases/status.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const snapshot: ChangeSnapshot = {
  changeName: "add-search",
  lifecycle: "READY",
  capturedAt: "2026-09-12T00:00:00.000Z",
  observations: { openSpec: "2026-09-12T00:00:00.000Z", repository: "2026-09-12T00:00:00.000Z" },
  digests: { artifact: "a", source: "b", head: "c", index: "d", diff: "e" },
  freshness: { review: "current", validation: "missing" },
  taskStates: {},
  pendingCheckpointIds: [],
  discrepancies: [],
};

async function project() {
  const cwd = await mkdtemp(resolve(tmpdir(), "muster-status-judgment-"));
  directories.push(cwd);
  return { cwd, store: createChangeUsageStore(cwd) };
}

const answered = (decision: string, acted: boolean) => ({
  decision,
  decisionVersion: 1,
  phase: "planning" as const,
  mode: "enforce" as const,
  requestedModel: "jev-1.13.0",
  reportedModel: "jev-1.13.0",
  stateDigest: "d",
  status: "answered" as const,
  unavailableReason: null,
  answers: {},
  gate: acted ? { act: true as const, value: {} } : { act: false as const, reason: "low confidence" },
  wouldHaveActed: acted,
  acted,
  spend: { inputTokens: 100, outputTokens: 0, costUsd: 0.0000042 },
});

describe("change status judgment block", () => {
  test("status shows the judgment block when the change has decision records", async () => {
    const { cwd, store } = await project();
    for (const record of [answered("change.triage", true), answered("change.triage", false)]) {
      await writeDecisionRecord(store, "add-search", createDecisionRecord("add-search", record as never));
    }
    const outcome = await runProductionStatus({ cwd, changeName: "add-search", snapshot, loadUsage: async () => null });
    expect(outcome.summary).toContain("Judgment:");
    expect(outcome.summary).toContain("change.triage v1: 2 calls, 1 acted, 1 would have acted");
  });

  test("status is unchanged without records", async () => {
    const { cwd } = await project();
    const outcome = await runProductionStatus({ cwd, changeName: "add-search", snapshot, loadUsage: async () => null });
    expect(outcome.summary).not.toContain("Judgment");
    expect(outcome.summary).toContain("Lifecycle: READY");
  });

  test("an unavailable decision is listed with its reasons", async () => {
    const summary = (await runProductionStatus({
      cwd: "/unused",
      changeName: "add-search",
      snapshot,
      loadUsage: async () => null,
      loadDecisions: async () => [{
        decision: "routing.task_model",
        decisionVersion: 1,
        calls: 3,
        unavailable: { timeout: 2 },
        shadow: 0,
        enforced: 1,
        wouldHaveActed: 0,
        acted: 0,
        reconciled: 1,
        agreed: 1,
        agreementRate: 1,
        spend: { inputTokens: 0, costUsd: 0 },
        avoided: { totalTokens: 0, costUsd: 0 },
      }],
    })).summary!;
    expect(summary).toContain("routing.task_model v1: 3 calls, 0 acted, 0 would have acted, unavailable (timeout 2), agreement 1 of 1");
  });
});
