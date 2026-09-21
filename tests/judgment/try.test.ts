import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInertJudgmentRuntime, createJudgmentRuntime, type JudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import { abstain, act, defineDecision } from "../../src/judgment/decision.ts";
import { tryJudge } from "../../src/judgment/try.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { createDeadClient, createScriptedClient } from "../helpers/scripted-judgment.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const decision = defineDecision<{ text: string }, string>({
  id: "test.try",
  version: 1,
  effects: ["adds_caution"],
  representativeInput: { text: "x" },
  state: (input) => input,
  questions: () => [["q", { type: "noul", instructions: "Is it so?" }]],
  gate: (answers) => (answers.q?.type === "noul" && answers.q.noul > 0.5 ? act("yes") : abstain("no")),
});

const request = { input: { text: "x" }, changeName: "add-search", phase: "planning" as const, state: { text: "x" } };
const yes = { q: { type: "noul", noul: 1 } } as never;

async function setup(mode: "shadow" | "enforce", client = createScriptedClient({ "test.try": yes })) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-try-"));
  directories.push(root);
  const store = new AtomicJsonStore(root);
  const runtime = createJudgmentRuntime({
    env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "sk-test", MUSTER_JEV_MODE: mode },
    store,
    client,
  });
  return { store, runtime };
}

describe("tryJudge", () => {
  test("disabled judgment yields no verdict", async () => {
    expect(await tryJudge(createInertJudgmentRuntime(), decision, request)).toBeNull();
  });

  test.each(["timeout", "network", "server", "invalid_response"] as const)(
    "an unavailable service (%s) yields no verdict",
    async (reason) => {
      const { runtime } = await setup("enforce", createDeadClient(reason) as never);
      expect(await tryJudge(runtime, decision, request)).toBeNull();
    },
  );

  test("a runtime that throws yields no verdict", async () => {
    const runtime = { enabled: true, judge: async () => { throw new Error("boom"); } } as unknown as JudgmentRuntime;
    expect(await tryJudge(runtime, decision, request)).toBeNull();
  });

  test("an enforce verdict carries the gate outcome", async () => {
    const { runtime } = await setup("enforce");
    const verdict = await tryJudge(runtime, decision, request);
    expect(verdict).toMatchObject({ kind: "enforce", outcome: { act: true, value: "yes" } });
  });

  test("a shadow verdict carries no outcome to act on", async () => {
    const { runtime } = await setup("shadow");
    const verdict = await tryJudge(runtime, decision, request);
    expect(verdict?.kind).toBe("shadow");
    expect(verdict && "outcome" in verdict).toBeFalse();
  });

  test("reconcile merges observations and an agreement into the record", async () => {
    const { runtime, store } = await setup("enforce");
    const verdict = (await tryJudge(runtime, decision, request))!;
    const merged = await verdict.reconcile({ path: "agent" }, true);
    expect(merged?.observed).toEqual({ path: "agent" });
    const [record] = await listDecisionRecords(store, "add-search");
    expect(record).toMatchObject({ observed: { path: "agent" }, agreement: true });
  });

  test("reconcile never raises when the store fails", async () => {
    const { runtime, store } = await setup("enforce");
    const verdict = (await tryJudge(runtime, decision, request))!;
    store.read = async () => { throw new Error("disk gone"); };
    expect(await verdict.reconcile({ path: "agent" })).toBeNull();
    store.write = async () => { throw new Error("disk gone"); };
    expect(await verdict.reconcile({ path: "agent" }, false)).toBeNull();
  });
});
