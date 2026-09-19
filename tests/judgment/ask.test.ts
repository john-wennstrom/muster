import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listChangeUsage } from "../../src/persistence/change-usage-store.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { BudgetLedger } from "../../src/telemetry/budget.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import {
  createInertJudgmentRuntime,
  createJudgmentRuntime,
  type JudgmentRuntimeOptions,
} from "../../src/judgment/ask.ts";
import {
  JUDGMENT_COST_PER_INPUT_TOKEN_USD,
  type JudgmentClient,
  type JudgmentClientRequest,
  type JudgmentClientResult,
  type JudgmentQuestions,
  type JudgmentUnavailableReason,
} from "../../src/judgment/client.ts";
import {
  abstain,
  act,
  defineDecision,
  noulBand,
  noulOf,
} from "../../src/judgment/gates.ts";
import { noul } from "../../src/judgment/questions.ts";
import {
  JudgmentFixtureMissingError,
  createDeadClient,
  createRecordingClient,
  createReplayClient,
} from "../../src/judgment/replay.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "judgment-ask-"));
  directories.push(path);
  return path;
}

const API_KEY = "sk-test-key-do-not-leak";
const enabled = { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: API_KEY };
const change = "judgment-layer";

const decision = defineDecision<{ request: string }, "escalate">({
  id: "test.sample",
  version: 1,
  effects: ["adds_caution"],
  representativeInput: { request: "x" },
  questions: ({ request }) => [
    ["public_contract", noul(`Does the request change a public contract? Request: ${request.length} chars`)],
  ],
  gate: (answers) => {
    const value = noulOf(answers, "public_contract");
    const band = value === null ? "uncertain" : noulBand(value, { yes: 0.7, no: 0.3 });
    return band === "yes" ? act("escalate") : abstain(`public_contract is ${band}`);
  },
});

function scripted(noulValue: number, inputTokens = 1_000) {
  const sent: JudgmentClientRequest[] = [];
  const client: JudgmentClient = {
    async request(request): Promise<JudgmentClientResult> {
      sent.push(request);
      return {
        available: true,
        answers: { public_contract: { type: "noul", noul: noulValue } },
        model: "jev-1.13.0",
        inputTokens,
        outputTokens: 0,
        durationMs: 12,
      };
    },
  };
  return { client, sent };
}

async function setup(overrides: Partial<JudgmentRuntimeOptions> = {}) {
  const root = await tempDirectory();
  const store = new AtomicJsonStore(root);
  const runtime = createJudgmentRuntime({ env: enabled, store, ...overrides });
  return { root, store, runtime };
}

const request = {
  input: { request: "Change the wire format" },
  changeName: change,
  phase: "planning" as const,
  state: { request: "Change the wire format" },
};

describe("judge verdicts", () => {
  test("shadow mode records the decision and hands the caller nothing to act on", async () => {
    const { client } = scripted(0.95);
    const { store, runtime } = await setup({ client });

    const verdict = await runtime.judge(decision, request);

    expect(verdict.kind).toBe("shadow");
    expect(verdict).not.toHaveProperty("outcome");
    const [record] = await listDecisionRecords(store, change);
    expect(record).toMatchObject({ mode: "shadow", wouldHaveActed: true, acted: false });
  });

  test("enforce mode hands over the gate's acting outcome and records that the caller acted", async () => {
    const { client } = scripted(0.95);
    const { store, runtime } = await setup({ client, env: { ...enabled, MUSTER_JEV_MODE: "enforce" } });

    const verdict = await runtime.judge(decision, request);

    expect(verdict).toMatchObject({ kind: "enforce", outcome: { act: true, value: "escalate" } });
    expect((await listDecisionRecords(store, change))[0]).toMatchObject({
      mode: "enforce",
      wouldHaveActed: true,
      acted: true,
      gate: { act: true, value: "escalate" },
    });
  });

  test("enforce mode abstains in the uncertain band", async () => {
    const { client } = scripted(0.5);
    const { store, runtime } = await setup({ client, env: { ...enabled, MUSTER_JEV_MODE: "enforce" } });

    expect(await runtime.judge(decision, request)).toMatchObject({
      kind: "enforce",
      outcome: { act: false, reason: "public_contract is uncertain" },
    });
    expect((await listDecisionRecords(store, change))[0]).toMatchObject({ wouldHaveActed: false, acted: false });
  });

  test("a decision record holds everything the specification names", async () => {
    const { client } = scripted(0.95, 2_000);
    const { store, runtime } = await setup({ client });
    await runtime.judge(decision, {
      ...request,
      avoided: { activity: "review", totalTokens: 15_000, costUsd: 0.1 },
    });

    expect((await listDecisionRecords(store, change))[0]).toMatchObject({
      decision: "test.sample",
      decisionVersion: 1,
      mode: "shadow",
      status: "answered",
      requestedModel: "jev-1.13.0",
      reportedModel: "jev-1.13.0",
      answers: { public_contract: { type: "noul", noul: 0.95 } },
      gate: { act: true, value: "escalate" },
      wouldHaveActed: true,
      acted: false,
      spend: { inputTokens: 2_000, outputTokens: 0 },
      avoided: { activity: "review", totalTokens: 15_000, costUsd: 0.1 },
    });
  });

  test("returns a record id the call site can reconcile", async () => {
    const { client } = scripted(0.95);
    const { store, runtime } = await setup({ client });
    const verdict = await runtime.judge(decision, request);

    const [record] = await listDecisionRecords(store, change);
    expect(verdict).toMatchObject({ recordId: record!.recordId });
  });

  test("passes the decision name and version to the client", async () => {
    const { client, sent } = scripted(0.95);
    const { runtime } = await setup({ client });
    await runtime.judge(decision, request);

    expect(sent[0]!.decision).toEqual({ id: "test.sample", version: 1 });
  });
});

describe("unavailable results fall back", () => {
  const reasons: JudgmentUnavailableReason[] = [
    "timeout", "rate_limit", "network", "server", "invalid_response", "aborted",
  ];

  test.each(reasons)("client reason %s yields the fallback verdict and a record, without an error", async (reason) => {
    const { store, runtime } = await setup({ client: createDeadClient(reason) });

    expect(await runtime.judge(decision, request)).toMatchObject({ kind: "fallback", reason });
    expect((await listDecisionRecords(store, change))[0]).toMatchObject({
      status: "unavailable",
      unavailableReason: reason,
      answers: null,
      gate: null,
    });
    expect(await listChangeUsage(store, change)).toEqual([]);
  });

  test("a model mismatch is unavailable and the mismatch is recorded", async () => {
    const client: JudgmentClient = {
      async request() {
        return { available: false, reason: "model_mismatch", reportedModel: "jev-1.14.0", durationMs: 3 };
      },
    };
    const { store, runtime } = await setup({ client });

    expect(await runtime.judge(decision, request)).toMatchObject({ kind: "fallback", reason: "model_mismatch" });
    expect((await listDecisionRecords(store, change))[0]).toMatchObject({
      unavailableReason: "model_mismatch",
      reportedModel: "jev-1.14.0",
    });
  });

  test("a client that throws is unavailable, never an error", async () => {
    const client: JudgmentClient = {
      async request() {
        throw new Error("socket exploded");
      },
    };
    const { runtime } = await setup({ client });

    expect(await runtime.judge(decision, request)).toMatchObject({ kind: "fallback", reason: "network" });
  });

  test("an unrecognized mode is unavailable, sends nothing, and is recorded", async () => {
    const { client, sent } = scripted(0.95);
    const { store, runtime } = await setup({ client, env: { ...enabled, MUSTER_JEV_MODE: "yolo" } });

    expect(await runtime.judge(decision, request)).toMatchObject({
      kind: "fallback",
      reason: "invalid_configuration",
    });
    expect(sent).toEqual([]);
    expect((await listDecisionRecords(store, change))[0]).toMatchObject({
      mode: null,
      unavailableReason: "invalid_configuration",
    });
  });

  test("a decision with its own flag runs only when that flag is set", async () => {
    const flagged = defineDecision({ ...decision, enabledBy: "MUSTER_JEV_TEST_FLAG" });
    const { client, sent } = scripted(0.95);
    const off = await setup({ client });
    expect(await off.runtime.judge(flagged, request)).toMatchObject({ kind: "fallback", reason: "disabled" });
    expect(sent).toEqual([]);
    expect(await listDecisionRecords(off.store, change)).toEqual([]);

    const on = await setup({ client, env: { ...enabled, MUSTER_JEV_TEST_FLAG: "1" } });
    expect(await on.runtime.judge(flagged, request)).toMatchObject({ kind: "shadow" });
    expect(sent).toHaveLength(1);
  });

  test("a persistence failure never reaches the caller", async () => {
    const { client } = scripted(0.95);
    const failures: unknown[] = [];
    const store = new AtomicJsonStore("/proc/definitely/not/writable");
    const runtime = createJudgmentRuntime({ env: enabled, store, client, onError: (e) => failures.push(e) });

    const verdict = await runtime.judge(decision, request);

    expect(verdict).toEqual({ kind: "shadow", recordId: null });
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe("disabled judgment is inert", () => {
  test.each([
    ["disabled", {}],
    ["disabled", { MUSTER_JEV_API_KEY: API_KEY }],
    ["not_configured", { MUSTER_JEV: "1" }],
  ] as const)("reports %s without any I/O", async (reason, env) => {
    const root = join(await tempDirectory(), "never-created");
    let calls = 0;
    let forecasts = 0;
    const client: JudgmentClient = { async request() { calls += 1; throw new Error("no"); } };
    const budget = new BudgetLedger({});
    const forecast = budget.forecast.bind(budget);
    budget.forecast = (input) => { forecasts += 1; return forecast(input); };
    const runtime = createJudgmentRuntime({ env, store: new AtomicJsonStore(root), client, budget });

    expect(runtime.enabled).toBe(false);
    expect(await runtime.judge(decision, request)).toEqual({ kind: "fallback", reason, recordId: null });
    expect(await runtime.askJev({
      decision, changeName: change, phase: "planning", state: "s",
      questions: { q: noul("Is it so?") },
    })).toMatchObject({ available: false, reason });
    expect(calls).toBe(0);
    expect(forecasts).toBe(0);
    await expect(access(root)).rejects.toThrow();
  });

  test("the inert runtime does nothing either", async () => {
    const runtime = createInertJudgmentRuntime("not_configured");
    expect(await runtime.judge(decision, request)).toEqual({ kind: "fallback", reason: "not_configured", recordId: null });
  });
});

describe("spend", () => {
  test("usage is recorded whether the decision acts, abstains, or runs in shadow", async () => {
    for (const [noulValue, env] of [
      [0.95, enabled],
      [0.5, { ...enabled, MUSTER_JEV_MODE: "enforce" }],
      [0.95, { ...enabled, MUSTER_JEV_MODE: "enforce" }],
    ] as const) {
      const { client } = scripted(noulValue, 4_200);
      const { store, runtime } = await setup({ client, env });
      await runtime.judge(decision, { ...request, taskId: "1.1" });

      const [usage] = await listChangeUsage(store, change);
      expect(usage).toMatchObject({
        role: "judgment",
        phase: "planning",
        taskId: "1.1",
        provider: "typesafe",
        model: "jev-1.13.0",
        inputTokens: 4_200,
        outputTokens: 0,
        totalTokens: 4_200,
      });
      expect(usage!.costUsd).toBeCloseTo(4_200 * JUDGMENT_COST_PER_INPUT_TOKEN_USD, 12);
    }
  });

  test("charges the budget ledger", async () => {
    const { client } = scripted(0.95, 500);
    const budget = new BudgetLedger({ roles: { judgment: { totalTokens: 1_000 } } });
    const { runtime } = await setup({ client, budget });

    await runtime.judge(decision, request);
    const next = budget.forecast({
      phase: "planning", role: "judgment", activity: "judgment",
      estimate: { totalTokens: 600, costUsd: 0 },
    });
    expect(next.status).toBe("skipped_optional");
  });

  test("an exhausted budget skips the request, sends nothing, and blocks nothing mandatory", async () => {
    const { client, sent } = scripted(0.95);
    const budget = new BudgetLedger({ phases: { planning: { totalTokens: 1 } } });
    const { store, runtime } = await setup({ client, budget });

    expect(await runtime.judge(decision, request)).toMatchObject({ kind: "fallback", reason: "budget" });
    expect(sent).toEqual([]);
    expect(await listChangeUsage(store, change)).toEqual([]);
    expect((await listDecisionRecords(store, change))[0]).toMatchObject({ unavailableReason: "budget" });
    expect(budget.forecast({
      phase: "validation", role: "validator", activity: "final_validation",
      estimate: { totalTokens: 1_000, costUsd: 0 },
    }).status).toBe("allowed");
  });
});

describe("egress through the entry point", () => {
  test("a state drawing on a credential file is refused before anything is sent", async () => {
    const { client, sent } = scripted(0.95);
    const { store, runtime } = await setup({ client });

    expect(await runtime.judge(decision, { ...request, sourcePaths: ["src/a.ts", ".env"] }))
      .toMatchObject({ kind: "fallback", reason: "state_denied" });
    expect(sent).toEqual([]);
    expect((await listDecisionRecords(store, change))[0]).toMatchObject({ unavailableReason: "state_denied" });
  });

  test("a state that is too large is refused, never truncated", async () => {
    const { client, sent } = scripted(0.95);
    const { runtime } = await setup({ client });

    expect(await runtime.judge(decision, { ...request, state: "x".repeat(200_000) }))
      .toMatchObject({ kind: "fallback", reason: "state_too_large" });
    expect(sent).toEqual([]);
  });

  test("the state is redacted before the client sees it", async () => {
    const { client, sent } = scripted(0.95);
    const { runtime } = await setup({ client });
    await runtime.judge(decision, {
      ...request,
      state: { failure: "Authorization: Bearer abc123.def456", note: `key ${API_KEY} leaked` },
    });

    const wire = JSON.stringify(sent[0]!.state);
    expect(wire).not.toContain("abc123.def456");
    expect(wire).not.toContain(API_KEY);
  });

  test("no part of the process environment appears in a sent state", async () => {
    const marker = "PROCESS-ENV-MARKER-8f3a";
    process.env.MUSTER_TEST_JUDGMENT_MARKER = marker;
    try {
      const { client, sent } = scripted(0.95);
      const { runtime } = await setup({ client });
      await runtime.judge(decision, request);

      expect(JSON.stringify(sent)).not.toContain(marker);
      expect(JSON.stringify(sent)).not.toContain(API_KEY);
    } finally {
      delete process.env.MUSTER_TEST_JUDGMENT_MARKER;
    }
  });

  test("the API key never appears in a record, usage record, or fixture", async () => {
    const root = await tempDirectory();
    const fixtures = await tempDirectory();
    const store = new AtomicJsonStore(root);
    const runtime = createJudgmentRuntime({
      env: enabled,
      store,
      client: createRecordingClient(scripted(0.95).client, fixtures),
    });
    await runtime.judge(decision, {
      ...request,
      state: { note: `the key is ${API_KEY}` },
    });

    const files = async (directory: string): Promise<string[]> =>
      (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
    const all = [...await files(root), ...await files(fixtures)];
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const path of all) expect(await readFile(path, "utf8")).not.toContain(API_KEY);
  });
});

describe("recorded fixtures through the entry point", () => {
  test("a recorded response is replayed with no network", async () => {
    const fixtures = await tempDirectory();
    const live = scripted(0.95);
    const recorder = await setup({ client: createRecordingClient(live.client, fixtures) });
    await recorder.runtime.judge(decision, request);

    const replayed = await setup({ client: createReplayClient(fixtures) });
    expect(await replayed.runtime.judge(decision, request)).toMatchObject({ kind: "shadow" });
    expect(live.sent).toHaveLength(1);
  });

  test("a missing recording fails the test instead of falling back", async () => {
    const { store, runtime } = await setup({ client: createReplayClient(await tempDirectory()) });

    await expect(runtime.judge(decision, request)).rejects.toBeInstanceOf(JudgmentFixtureMissingError);
    await expect(runtime.judge(decision, request)).rejects.toThrow(/test\.sample/);
    expect(await listDecisionRecords(store, change)).toEqual([]);
  });
});

describe("transport call", () => {
  test("returns typed answers and the usage record", async () => {
    const { client } = scripted(0.8, 900);
    const { runtime } = await setup({ client });
    const questions: JudgmentQuestions = { public_contract: noul("Does it change a contract?") };

    const result = await runtime.askJev({
      decision, changeName: change, phase: "implementation", state: "s", questions,
    });

    expect(result).toMatchObject({
      available: true,
      mode: "shadow",
      reportedModel: "jev-1.13.0",
      inputTokens: 900,
      usage: { role: "judgment", phase: "implementation" },
    });
  });
});
