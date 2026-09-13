import { describe, expect, test } from "bun:test";
import type { ChangeSnapshot } from "../../src/controller/change-snapshot.ts";
import {
  dispatchLegacyChangeCommand,
  legacyCommandGuidance,
} from "../../src/extension/change-command.ts";

const observedAt = "2026-09-12T12:00:00.000Z";

function snapshot(lifecycle: ChangeSnapshot["lifecycle"]): ChangeSnapshot {
  return {
    changeName: "add-search",
    lifecycle,
    capturedAt: observedAt,
    observations: { openSpec: observedAt, repository: observedAt },
    digests: { artifact: "a", source: "b", head: "c", index: "d", diff: "e" },
    freshness: {
      review: lifecycle === "REVIEW_REQUIRED" ? "missing" : "current",
      validation: lifecycle === "VERIFIED" ? "current" : "missing",
    },
    taskStates: { "1.1": lifecycle === "VERIFIED" },
    pendingCheckpointIds: lifecycle === "AWAITING_USER" ? ["checkpoint-1"] : [],
    discrepancies: [],
  };
}

function context(notifications: string[]) {
  return { ui: { notify: (message: string) => notifications.push(message) } };
}

describe("legacy workflow compatibility", () => {
  test("keeps refine usable and names its preferred equivalent", async () => {
    const notifications: string[] = [];
    let invoked = 0;
    await dispatchLegacyChangeCommand(
      "refine",
      "add-search",
      context(notifications),
      { loadSnapshot: async () => snapshot("PLANNING") },
      async () => { invoked++; },
    );

    expect(invoked).toBe(1);
    expect(notifications).toEqual([
      legacyCommandGuidance("refine", "add-search"),
    ]);
    expect(notifications[0]).toContain("/change refine add-search");
  });

  test("blocks legacy implement until the current planning review is approved", async () => {
    const notifications: string[] = [];
    let invoked = 0;
    await dispatchLegacyChangeCommand(
      "implement",
      "add-search",
      context(notifications),
      { loadSnapshot: async () => snapshot("REVIEW_REQUIRED") },
      async () => { invoked++; },
    );

    expect(invoked).toBe(0);
    expect(notifications[0]).toContain("/change implement add-search");
    expect(notifications[1]).toContain("Next: /change review add-search");
  });

  test("blocks legacy implement at a manual stop and preserves resume guidance", async () => {
    const notifications: string[] = [];
    let invoked = 0;
    await dispatchLegacyChangeCommand(
      "implement",
      "add-search",
      context(notifications),
      { loadSnapshot: async () => snapshot("AWAITING_USER") },
      async () => { invoked++; },
    );

    expect(invoked).toBe(0);
    expect(notifications[1]).toContain("Next: /change resume add-search");
  });

  test("allows reviewed implementation and verified shipping through the shared gate", async () => {
    const notifications: string[] = [];
    const invoked: string[] = [];
    await dispatchLegacyChangeCommand(
      "implement",
      "add-search",
      context(notifications),
      { loadSnapshot: async () => snapshot("READY") },
      async () => { invoked.push("implement"); },
    );
    await dispatchLegacyChangeCommand(
      "ship",
      "add-search",
      context(notifications),
      { loadSnapshot: async () => snapshot("VERIFIED") },
      async () => { invoked.push("ship"); },
    );

    expect(invoked).toEqual(["implement", "ship"]);
    expect(notifications[1]).toContain("/change finish add-search");
  });
});