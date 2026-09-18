import { describe, expect, test } from "bun:test";
import {
  changeUsage,
  changeSubcommands,
  dispatchChangeCommand,
  parseChangeCommand,
  type ChangeCommandDependencies,
} from "../../src/change/change-command.ts";
import { changeCommands } from "../../src/change/commands.ts";
import { musterChangeDetails, type MusterChangeDetails } from "../../src/change/branding.ts";
import { renderCommandOutcome, type CommandOutcome } from "../../src/change/command.ts";
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
  const sentMessages: string[] = [];
  const sentDetails: MusterChangeDetails[] = [];
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
    sentMessages,
    sentDetails,
    dependencies,
    context: {
      ui: { notify: (message: string) => notifications.push(message) },
      // Mirrors a real host: renders the outcome to content and keeps its structured details.
      sendMessage: (message: CommandOutcome | string) => {
        sentMessages.push(typeof message === "string" ? message : renderCommandOutcome(message));
        if (typeof message !== "string") sentDetails.push(musterChangeDetails(message));
      },
    },
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
    expect(subject.sentMessages[0]).toContain("Next: /change review add-search");
    expect(subject.sentMessages[0]).toContain("review.md");
  });

  test("renders derived status without a mutating handler", async () => {
    const subject = harness("AWAITING_USER");
    await dispatchChangeCommand("status add-search", subject.context, subject.dependencies);
    expect(subject.sentMessages[0]).toContain("Lifecycle: AWAITING_USER");
    expect(subject.sentMessages[0]).toContain(HOST_EXECUTION_SECURITY_NOTICE);
    expect(subject.sentMessages[0]).not.toMatch(/\bsandboxed\b/i);
    expect(subject.mutations).toEqual([]);
  });

  test("explore dispatches the whole prompt to its handler, unsplit by whitespace", async () => {
    const subject = harness();
    const seen: unknown[] = [];
    subject.dependencies.handlers.explore = async (command) => { seen.push(command); };
    await dispatchChangeCommand("explore why is the retry loop slow", subject.context, subject.dependencies);
    expect(seen).toEqual([{
      action: "explore",
      changeName: undefined,
      arguments: ["why", "is", "the", "retry", "loop", "slow"],
    }]);
  });

  test("handlers can post durable transcript output via sendMessage instead of the transient notify toast", async () => {
    const subject = harness();
    subject.dependencies.handlers.explore = async (_command, context) => {
      context.sendMessage?.("## Findings\nThe retry loop lacks backoff.");
    };
    await dispatchChangeCommand("explore why is the retry loop slow", subject.context, subject.dependencies);
    expect(subject.sentMessages).toEqual(["## Findings\nThe retry loop lacks backoff."]);
    expect(subject.notifications).toEqual([]);
  });

  test("outcomes reach the transcript with structured details alongside their rendered content", async () => {
    const subject = harness("READY");
    subject.dependencies.handlers.implement = async () => ({
      status: "success" as const,
      action: "implement" as const,
      changeName: "add-search",
      runId: "run-add-search",
      summary: "Implemented 3 tasks.",
    });
    await dispatchChangeCommand("implement add-search", subject.context, subject.dependencies);
    expect(subject.sentDetails).toEqual([{
      action: "implement",
      changeName: "add-search",
      status: "success",
      runId: "run-add-search",
      code: undefined,
    }]);
    expect(subject.sentMessages[0]).toContain("Implemented 3 tasks.");
  });

  test("a host without sendMessage still receives the rendered outcome as a notification", async () => {
    const subject = harness("REVIEW_REQUIRED");
    const context = { ui: subject.context.ui };
    await dispatchChangeCommand("implement add-search", context, subject.dependencies);
    expect(subject.notifications[0]).toContain("Next: /change review add-search");
  });

  test("standalone exploration never resolves or loads a remembered change", async () => {
    const subject = harness();
    let resolved = false;
    let loaded = false;
    subject.dependencies.resolveChangeName = async () => { resolved = true; return "add-search"; };
    subject.dependencies.loadSnapshot = async () => { loaded = true; return snapshot("READY"); };
    subject.dependencies.handlers.explore = async () => undefined;

    await dispatchChangeCommand("explore inspect the parser", subject.context, subject.dependencies);

    expect(resolved).toBe(false);
    expect(loaded).toBe(false);
  });

  test("status and rejected mutations do not activate a change", async () => {
    const subject = harness("REVIEW_REQUIRED");
    const activated: string[] = [];
    subject.dependencies.activateChange = async (changeName) => { activated.push(changeName); };

    await dispatchChangeCommand("status add-search", subject.context, subject.dependencies);
    await dispatchChangeCommand("implement add-search", subject.context, subject.dependencies);

    expect(activated).toEqual([]);
  });
});

describe("parseChangeCommand", () => {
  test("explore keeps the whole remainder as a free-text prompt, not a change slug", () => {
    expect(parseChangeCommand("explore why does the retry loop spin forever")).toEqual({
      action: "explore",
      changeName: undefined,
      arguments: ["why", "does", "the", "retry", "loop", "spin", "forever"],
    });
  });

  test("other actions still split into change + arguments", () => {
    expect(parseChangeCommand("propose add-search Add full text search")).toEqual({
      action: "propose",
      changeName: "add-search",
      arguments: ["Add", "full", "text", "search"],
    });
  });
});

describe("changeCommands", () => {
  test("every advertised subcommand is declared", () => {
    expect([...changeSubcommands].sort()).toEqual((Object.keys(changeCommands) as typeof changeSubcommands).toSorted());
    for (const action of changeSubcommands) {
      const spec = changeCommands[action];
      expect(spec.usage.startsWith(`/change ${action}`)).toBe(true);
      expect(spec.arity.max === null || spec.arity.max >= spec.arity.min).toBe(true);
    }
  });

  test("free-text parsing follows the declared argument shape", () => {
    for (const action of changeSubcommands) {
      const parsed = parseChangeCommand(`${action} add-search rest of it`)!;
      const expectsChange = changeCommands[action].args !== "free-text";
      expect(parsed.changeName).toEqual(expectsChange ? "add-search" : undefined);
    }
  });

  test("an argument count outside the declared arity is blocked before any phase work", async () => {
    const subject = harness("READY");
    const activated: string[] = [];
    subject.dependencies.activateChange = async (changeName) => { activated.push(changeName); };
    subject.dependencies.handlers.resume = async () => { throw new Error("handler must not run"); };

    await dispatchChangeCommand("resume add-search one two", subject.context, subject.dependencies);

    expect(subject.sentMessages[0]).toContain(changeCommands.resume.usage);
    expect(activated).toEqual([]);
    expect(subject.mutations).toEqual([]);
  });
});
