import { describe, expect, test } from "bun:test";
import {
  changeUsage,
  dispatchChangeCommand,
  type ChangeCommandDependencies,
} from "../../src/muster/change-command.ts";
import type { ChangeSnapshot } from "../../src/controller/change-snapshot.ts";
import { HOST_EXECUTION_SECURITY_NOTICE } from "../../src/tools/command-profile.ts";

function snapshot(lifecycle: ChangeSnapshot["lifecycle"]): ChangeSnapshot {
  return {
    changeName: "add-search",
    lifecycle,
    capturedAt: "2026-09-12T12:00:00.000Z",
    observations: { openSpec: "2026-09-12T12:00:00.000Z", repository: "2026-09-12T12:00:00.000Z" },
    digests: { artifact: "a", source: "b", head: "c", index: "d", diff: "e" },
    freshness: { review: lifecycle === "REVIEW_REQUIRED" ? "missing" : "current", validation: "missing" },
    taskStates: { "1.1": false },
    pendingCheckpointIds: [],
    discrepancies: [],
  };
}

function harness(lifecycle: ChangeSnapshot["lifecycle"] = "READY") {
  const notifications: string[] = [];
  const mutations: string[] = [];
  const dependencies: ChangeCommandDependencies = {
    resolveChangeName: async (explicit) => explicit ?? "add-search",
    loadSnapshot: async () => snapshot(lifecycle),
    handlers: {
      implement: async (command) => { mutations.push(`implement:${command.changeName}`); },
    },
  };
  return {
    notifications,
    mutations,
    dependencies,
    context: { ui: { notify: (message: string) => notifications.push(message) } },
  };
}

describe("change command", () => {
  test("unknown commands show complete help without mutation", async () => {
    const subject = harness();
    await dispatchChangeCommand("unknown add-search", subject.context, subject.dependencies);
    expect(subject.mutations).toEqual([]);
    expect(subject.notifications).toEqual([changeUsage]);
    expect(changeUsage).toContain(HOST_EXECUTION_SECURITY_NOTICE);
    expect(changeUsage).not.toMatch(/\bsandboxed\b/i);
  });

  test("resolves the active change and dispatches an allowed command", async () => {
    const subject = harness("READY");
    await dispatchChangeCommand("implement", subject.context, subject.dependencies);
    expect(subject.mutations).toEqual(["implement:add-search"]);
  });

  test("directs implementation to review when approval is missing", async () => {
    const subject = harness("REVIEW_REQUIRED");
    await dispatchChangeCommand("implement add-search", subject.context, subject.dependencies);
    expect(subject.mutations).toEqual([]);
    expect(subject.notifications[0]).toContain("Next: /change review add-search");
  });

  test("renders derived status without a mutating handler", async () => {
    const subject = harness("AWAITING_USER");
    await dispatchChangeCommand("status add-search", subject.context, subject.dependencies);
    expect(subject.notifications[0]).toContain("Lifecycle: AWAITING_USER");
    expect(subject.notifications[0]).toContain(HOST_EXECUTION_SECURITY_NOTICE);
    expect(subject.notifications[0]).not.toMatch(/\bsandboxed\b/i);
    expect(subject.mutations).toEqual([]);
  });
});