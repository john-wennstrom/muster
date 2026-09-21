import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { createJudgmentRuntime, type JudgmentVerdict } from "../../src/judgment/ask.ts";
import type { JudgmentUnavailableReason } from "../../src/judgment/client.ts";
import { abstain, act, defineDecision, noulBand, noulOf } from "../../src/judgment/decision.ts";
import { noul } from "../../src/judgment/questions.ts";
import { createDeadClient } from "../helpers/scripted-judgment.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Total over the reasons, so adding a reason without covering it here fails typechecking. */
const everyReason: Record<JudgmentUnavailableReason, true> = {
  disabled: true,
  not_configured: true,
  invalid_configuration: true,
  budget: true,
  state_denied: true,
  state_too_large: true,
  timeout: true,
  rate_limit: true,
  network: true,
  server: true,
  invalid_response: true,
  model_mismatch: true,
  aborted: true,
};
const reasons = Object.keys(everyReason) as JudgmentUnavailableReason[];

const TODAY = "what the harness does today";
const JUDGED = "what judgment would do";

const decision = defineDecision<{ request: string }, string>({
  id: "test.fallback",
  version: 1,
  effects: ["reduces_work"],
  representativeInput: { request: "x" },
  state: (input) => input,
  questions: () => [["q", noul("Is it so?")]],
  gate: (answers) => {
    const value = noulOf(answers, "q");
    return value !== null && noulBand(value, { yes: 0.7, no: 0.3 }) === "yes"
      ? act(JUDGED)
      : abstain("uncertain");
  },
});

/** A call site as the rollout writes them: judgment may only ever refine today's behavior. */
function callSite(verdict: JudgmentVerdict<string>): string {
  if (verdict.kind === "enforce" && verdict.outcome.act) return verdict.outcome.value;
  return TODAY;
}

async function runtime(client = createDeadClient()) {
  const path = await mkdtemp(join(tmpdir(), "judgment-fallback-"));
  directories.push(path);
  return createJudgmentRuntime({
    env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "k", MUSTER_JEV_MODE: "enforce" },
    store: new AtomicJsonStore(path),
    client,
  });
}

const request = {
  input: { request: "x" },
  changeName: "judgment-layer",
  phase: "planning" as const,
  state: "state",
};

describe("fallback", () => {
  test.each(reasons)("a dead client reporting %s leaves the caller with today's behavior", async (reason) => {
    const { judge } = await runtime(createDeadClient(reason));
    const verdict = await judge(decision, request);

    expect(verdict).toMatchObject({ kind: "fallback", reason });
    expect(callSite(verdict)).toBe(TODAY);
  });

  test("the call site only ever acts on an enforced, acting outcome", () => {
    expect(callSite({ kind: "shadow", recordId: null })).toBe(TODAY);
    expect(callSite({ kind: "fallback", reason: "timeout", recordId: null })).toBe(TODAY);
    expect(callSite({ kind: "enforce", outcome: { act: false, reason: "uncertain" }, recordId: null })).toBe(TODAY);
    expect(callSite({ kind: "enforce", outcome: { act: true, value: JUDGED }, recordId: null })).toBe(JUDGED);
  });

  test("the whole stack degrades when the service is unreachable", async () => {
    const path = await mkdtemp(join(tmpdir(), "judgment-fallback-"));
    directories.push(path);
    const live = createJudgmentRuntime({
      env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "k", MUSTER_JEV_MODE: "enforce" },
      store: new AtomicJsonStore(path),
      fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    });

    const verdict = await live.judge(decision, request);
    expect(verdict).toMatchObject({ kind: "fallback", reason: "network" });
    expect(callSite(verdict)).toBe(TODAY);
  });

  test("the whole stack degrades when the response is unusable", async () => {
    const path = await mkdtemp(join(tmpdir(), "judgment-fallback-"));
    directories.push(path);
    const responses = [
      { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 10 } },
      { model: "jev-1.13.0", answers: { q: { type: "noul", noul: 7 } }, usage: { input_tokens: 10 } },
      "not even an object",
    ];
    for (const body of responses) {
      const live = createJudgmentRuntime({
        env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "k", MUSTER_JEV_MODE: "enforce" },
        store: new AtomicJsonStore(path),
        fetch: (async () => Response.json(body)) as unknown as typeof fetch,
      });
      const verdict = await live.judge(decision, request);
      expect(verdict).toMatchObject({ kind: "fallback", reason: "invalid_response" });
      expect(callSite(verdict)).toBe(TODAY);
    }
  });

  test("the whole stack degrades when the service keeps rate limiting", async () => {
    const path = await mkdtemp(join(tmpdir(), "judgment-fallback-"));
    directories.push(path);
    const live = createJudgmentRuntime({
      env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "k" },
      store: new AtomicJsonStore(path),
      fetch: (async () => new Response("", { status: 429 })) as unknown as typeof fetch,
    });

    const verdict = await live.judge(decision, { ...request, deadlineMs: 5_000 });
    expect(verdict).toMatchObject({ kind: "fallback", reason: "rate_limit" });
    expect(callSite(verdict)).toBe(TODAY);
  });
});
