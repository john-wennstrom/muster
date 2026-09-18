import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeSnapshot } from "../../src/controller/change-snapshot.ts";
import type { ChangeAction } from "../../src/controller/action-resolver.ts";
import registerMuster from "../../src/muster/index.ts";
import type { CommandOutcome } from "../../src/change/command.ts";
import type { ProductionRuntimeOptions } from "../../src/change/dependencies.ts";

interface RegisteredCommand {
  description: string;
  handler: (args: string, context: unknown) => Promise<void> | void;
}

function snapshot(lifecycle: ChangeSnapshot["lifecycle"]): ChangeSnapshot {
  return {
    changeName: "add-search",
    lifecycle,
    capturedAt: "2026-09-17T12:00:00.000Z",
    observations: {
      openSpec: "2026-09-17T12:00:00.000Z",
      repository: "2026-09-17T12:00:00.000Z",
    },
    digests: { artifact: "artifact", source: "source", head: "head", index: "index", diff: "diff" },
    freshness: {
      review: lifecycle === "PLANNING" || lifecycle === "REVIEW_REQUIRED" ? "missing" : "current",
      validation: lifecycle === "VERIFIED" ? "current" : "missing",
    },
    taskStates: { "1.1": lifecycle === "VERIFYING" || lifecycle === "VERIFIED" },
    pendingCheckpointIds: lifecycle === "AWAITING_USER" ? ["checkpoint-1"] : [],
    discrepancies: [],
  };
}

function apiHarness() {
  const commands = new Map<string, RegisteredCommand>();
  const messages: string[] = [];
  const api = {
    getFlag: () => undefined,
    on: () => undefined,
    registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
    registerFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI;
  return { api, commands, messages };
}

const invocations: ReadonlyArray<{
  action: ChangeAction;
  args: string;
  lifecycle: ChangeSnapshot["lifecycle"];
}> = [
  { action: "explore", args: "explore inspect the task graph", lifecycle: "PLANNING" },
  { action: "propose", args: "propose add-search add full text search", lifecycle: "PLANNING" },
  { action: "refine", args: "refine add-search clarify ranking", lifecycle: "PLANNING" },
  { action: "review", args: "review add-search", lifecycle: "REVIEW_REQUIRED" },
  { action: "implement", args: "implement add-search", lifecycle: "READY" },
  { action: "resume", args: "resume add-search checkpoint-1", lifecycle: "AWAITING_USER" },
  { action: "verify", args: "verify add-search", lifecycle: "VERIFYING" },
  { action: "finish", args: "finish add-search", lifecycle: "VERIFIED" },
  { action: "status", args: "status add-search", lifecycle: "READY" },
];

describe("production command assembly", () => {
  for (const invocation of invocations) {
    test(`default registration reaches the ${invocation.action} production path exactly once`, async () => {
      const root = resolve(import.meta.dir, "fixture-repository");
      const reached: string[] = [];
      const outcome = (action: ChangeAction): CommandOutcome => ({
        status: "success",
        action,
        changeName: action === "explore" ? undefined : "add-search",
        runId: action === "status" || action === "explore" ? undefined : `run-${action}`,
        summary: `${action} controller reached`,
      });
      const options: ProductionRuntimeOptions = {
        cwd: resolve(import.meta.dir, "extension-startup-repository"),
        argv: [],
        ports: {
          resolveChange: async ({ planningHome, changeName }) => {
            expect(planningHome).toBe(root);
            return {
              name: changeName,
              planningHome,
              changesDirectory: resolve(planningHome, "openspec", "changes"),
              changeRoot: resolve(planningHome, "openspec", "changes", changeName),
              exists: invocation.action !== "propose",
            };
          },
          loadSnapshot: async ({ cwd }) => {
            expect(cwd).toBe(root);
            reached.push("snapshot");
            return snapshot(invocation.lifecycle);
          },
          loadUsage: async ({ cwd }) => {
            expect(cwd).toBe(root);
            reached.push("usage");
            return null;
          },
          activateChange: async ({ cwd }) => {
            expect(cwd).toBe(root);
            reached.push("activate");
          },
        },
        runners: {
          explore: async ({ cwd }) => {
            expect(cwd).toBe(root);
            reached.push("explore");
            return outcome("explore");
          },
          planning: async ({ cwd, phase }) => {
            expect(cwd).toBe(root);
            reached.push(phase);
            return outcome(phase);
          },
          review: async ({ cwd }) => {
            expect(cwd).toBe(root);
            reached.push("review");
            return outcome("review");
          },
          implementation: async ({ cwd, checkpointId }) => {
            expect(cwd).toBe(root);
            const action = checkpointId ? "resume" : "implement";
            reached.push(action);
            return outcome(action);
          },
          verification: async ({ cwd }) => {
            expect(cwd).toBe(root);
            reached.push("verify");
            return outcome("verify");
          },
          finish: async ({ cwd }) => {
            expect(cwd).toBe(root);
            reached.push("finish");
            return outcome("finish");
          },
        },
      };
      const subject = apiHarness();
      registerMuster(subject.api, undefined, options);

      await subject.commands.get("change")!.handler(invocation.args, {
        cwd: root,
        signal: new AbortController().signal,
        ui: { notify: () => undefined },
      });

      expect(subject.messages).toHaveLength(1);
      expect(subject.messages[0]).toContain(`## /change ${invocation.action}`);
      expect(subject.messages[0]).toContain("Status: success");
      if (invocation.action === "status") {
        expect(reached).toContain("snapshot");
        expect(reached).toContain("usage");
      } else {
        expect(reached).toContain(invocation.action);
      }
    });
  }
});
