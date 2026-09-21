import { describe, expect, test } from "bun:test";
import { newRun } from "../../src/agents/run-record.ts";
import type { ChangeSnapshot } from "../../src/controller/change-snapshot.ts";
import type { ChangeCommandContext } from "../../src/change/change-command.ts";
import { changeCommands } from "../../src/change/commands.ts";
import { createCommandRunContext } from "../../src/change/command.ts";
import { defineChangeHandler, type ChangeHandlerRequest } from "../../src/change/handler.ts";
import { resolveActor, FALLBACK_ACTOR } from "../../src/shared/actor.ts";

function context(overrides: Partial<ChangeCommandContext> = {}): ChangeCommandContext {
  return { ui: { notify() {} }, ...overrides };
}

describe("defineChangeHandler", () => {
  test("supplies the change name as a required value for actions that declare one", async () => {
    let seen: ChangeHandlerRequest<"implement"> | undefined;
    const handler = defineChangeHandler("implement", async (request) => {
      seen = request;
      // Compiles without an assertion: the declaration types this as string.
      return { status: "success" as const, summary: request.changeName.toUpperCase() };
    })("/repo", {});

    const outcome = await handler(
      { action: "implement", changeName: "add-search", arguments: [] },
      context(),
    );

    expect(seen?.changeName).toBe("add-search");
    expect(outcome).toMatchObject({ action: "implement", changeName: "add-search", summary: "ADD-SEARCH" });
  });

  test("blocks with the declared usage when a required change name is absent", async () => {
    let ran = false;
    const handler = defineChangeHandler("verify", async () => {
      ran = true;
      return { status: "success" as const, summary: "never" };
    })("/repo", {});

    const outcome = await handler({ action: "verify", arguments: [] }, context());

    expect(ran).toBe(false);
    expect(outcome).toMatchObject({ status: "blocked", action: "verify" });
    expect((outcome as { summary: string }).summary).toContain(changeCommands.verify.usage);
  });

  test("blocks when the argument count falls outside the declared arity", async () => {
    let ran = false;
    const handler = defineChangeHandler("resume", async () => {
      ran = true;
      return { status: "success" as const, summary: "never" };
    })("/repo", {});

    const outcome = await handler(
      { action: "resume", changeName: "add-search", arguments: ["a", "b"] },
      context(),
    );

    expect(ran).toBe(false);
    expect(ran).toBe(false);
    expect(outcome).toMatchObject({ status: "blocked", action: "resume", changeName: "add-search" });
  });

  test("carries the cancellation signal, run identity and agent observer into every handler", async () => {
    const controller = new AbortController();
    const observed: string[] = [];
    const seen: Partial<Record<string, ChangeHandlerRequest>> = {};

    for (const action of Object.keys(changeCommands) as (keyof typeof changeCommands)[]) {
      const handler = defineChangeHandler(action, async (request) => {
        seen[action] = request as ChangeHandlerRequest;
        request.onAgentStart?.(newRun("ARCHITECT", "provider/model"));
        return { status: "success" as const, summary: "ok" };
      })("/repo", {});
      await handler(
        { action, changeName: "add-search", arguments: action === "resume" ? ["cp-1"] : ["hello"] },
        context({
          signal: controller.signal,
          run: { runId: `run-${action}` } as never,
          onAgentStart: () => observed.push(action),
        }),
      );
    }

    for (const action of Object.keys(changeCommands)) {
      expect(seen[action]?.signal).toBe(controller.signal);
      expect(seen[action]?.runId).toBe(`run-${action}`);
    }
    expect(observed.sort()).toEqual(Object.keys(changeCommands).sort());
  });

  test("loads the change snapshot at most once and only when a handler asks for it", async () => {
    let loads = 0;
    const snapshot = { freshness: { review: "current" } } as ChangeSnapshot;
    const options = { ports: { loadSnapshot: async () => { loads++; return snapshot; } } };

    const unused = defineChangeHandler("verify", async () => ({ status: "success" as const, summary: "ok" }))("/repo", options);
    await unused({ action: "verify", changeName: "add-search", arguments: [] }, context());
    expect(loads).toBe(0);

    const used = defineChangeHandler("implement", async (request) => {
      await request.snapshot();
      await request.snapshot();
      return { status: "success" as const, summary: "ok" };
    })("/repo", options);
    await used({ action: "implement", changeName: "add-search", arguments: [] }, context());
    expect(loads).toBe(1);
  });

  test("records the actor supplied by the host rather than a fixed placeholder", async () => {
    let seen = "";
    const handler = defineChangeHandler("resume", async (request) => {
      seen = request.actor;
      return { status: "success" as const, summary: "ok" };
    })("/repo", {});

    await handler(
      { action: "resume", changeName: "add-search", arguments: ["cp-1"] },
      context({ actor: "alice" }),
    );
    expect(seen).toBe("alice");

    await handler({ action: "resume", changeName: "add-search", arguments: ["cp-1"] }, context());
    expect(seen).toBe(FALLBACK_ACTOR);
  });
});

describe("resolveActor", () => {
  test("prefers the explicit override over the operating-system user", () => {
    expect(resolveActor({ MUSTER_ACTOR: "release-bot" })).toBe("release-bot");
  });

  test("falls back to a real identity when no override is set", () => {
    expect(resolveActor({}).length).toBeGreaterThan(0);
  });
});

describe("createCommandRunContext", () => {
  test("does not resolve role models until a consumer reads them", () => {
    let resolutions = 0;
    const run = createCommandRunContext({
      action: "status",
      repositoryCwd: "/repo",
      output: { write() {} },
      models: () => {
        resolutions++;
        return { architect: "provider/architect" };
      },
    });

    expect(run.runId).toBeUndefined();
    expect(resolutions).toBe(0);

    expect(run.models.architect).toBe("provider/architect");
    expect(run.models.architect).toBe("provider/architect");
    expect(resolutions).toBe(1);
  });
});
