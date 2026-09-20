import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJudgmentRuntime, createInertJudgmentRuntime, type JudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type {
  JudgmentAnswers,
  JudgmentClient,
  JudgmentClientRequest,
  JudgmentClientResult,
  JudgmentUnavailableReason,
} from "../../src/judgment/client.ts";
import { THRASH_QUESTION_IDS as ids } from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { BudgetLedger } from "../../src/telemetry/budget.ts";
import { createDebuggingState, recordUnexpectedFailure } from "../../src/policies/debugging.ts";
import {
  THRASH_ATTEMPT_KEY,
  THRASH_ATTEMPTED_FIX_BYTES,
  THRASH_EVIDENCE_BYTES,
  THRASH_OUTCOME_KEY,
  THRASH_PATH_KEY,
  THRASH_REPRODUCTION_BYTES,
  assessRepairProgress,
  buildThrashInput,
  reconcileRepairOutcome,
  type RepairAssessment,
} from "../../src/policies/repair-progress.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const change = "judgment-thrash-detection";
const at = (minute: number) => `2026-09-12T12:${String(minute).padStart(2, "0")}:00.000Z`;
const noul = (value: number) => ({ type: "noul" as const, noul: value });

const stalledAnswers: JudgmentAnswers = {
  [ids.sameRootCause]: noul(0.95),
  [ids.changed]: noul(0.1),
  [ids.progress]: noul(0.05),
  [ids.located]: noul(0.4),
  [ids.humanNeeded]: noul(0.05),
  [ids.fixFit]: { type: "score", score: 1, probabilities: { "1": 0.6 }, confidence: 0.6 },
};

function scripted(answers: JudgmentAnswers, unavailable?: JudgmentUnavailableReason) {
  const sent: JudgmentClientRequest[] = [];
  const client: JudgmentClient = {
    async request(request): Promise<JudgmentClientResult> {
      sent.push(request);
      if (unavailable) return { available: false, reason: unavailable, durationMs: 1 };
      return { available: true, answers, model: "jev-1.13.0", inputTokens: 1_000, outputTokens: 0, durationMs: 5 };
    },
  };
  return { client, sent };
}

async function setup(options: {
  mode?: "shadow" | "enforce";
  client: JudgmentClient;
  env?: Record<string, string>;
  budget?: BudgetLedger;
}) {
  const path = await mkdtemp(join(tmpdir(), "repair-progress-"));
  directories.push(path);
  const store = new AtomicJsonStore(path);
  const runtime: JudgmentRuntime = createJudgmentRuntime({
    env: options.env ?? { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "sk-test", MUSTER_JEV_MODE: options.mode ?? "enforce" },
    store,
    client: options.client,
    budget: options.budget,
  });
  return { store, runtime };
}

function failures(threshold: number, count: number, extra: { attemptedFix?: (attempt: number) => string | undefined; evidence?: string[] } = {}) {
  let state = createDebuggingState({ runId: "run-1", taskId: "1.1", threshold, createdAt: at(0) });
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const attemptedFix = extra.attemptedFix ? extra.attemptedFix(attempt) : `fix ${attempt}`;
    state = recordUnexpectedFailure(state, {
      reproduction: "bun test tests/a.test.ts",
      evidence: extra.evidence ?? [`assertion failed on attempt ${attempt}`],
      ...(attemptedFix ? { attemptedFix } : {}),
      recordedAt: at(attempt),
    });
  }
  return state;
}

/** Assesses attempts 2..count in order, each round failing once more, as a repair loop would. */
async function runRounds(
  runtime: JudgmentRuntime,
  store: AtomicJsonStore,
  threshold: number,
  rounds: number,
) {
  let state = failures(threshold, 1);
  const results: RepairAssessment[] = [];
  for (let attempt = 2; attempt <= rounds + 1; attempt += 1) {
    state = recordUnexpectedFailure(state, {
      reproduction: "bun test tests/a.test.ts",
      evidence: [`assertion failed on attempt ${attempt}`],
      attemptedFix: `fix ${attempt}`,
      recordedAt: at(attempt),
    });
    const result = await assessRepairProgress({
      runtime, store, changeName: change, taskDefinition: "Fix the parser", state, now: () => new Date(at(attempt)),
    });
    state = result.state;
    results.push(result);
  }
  return { state, results };
}

describe("assessment preconditions", () => {
  test("the first failure is not assessed and nothing is sent", async () => {
    const { client, sent } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client });
    const state = failures(5, 1);
    const result = await assessRepairProgress({ runtime, store, changeName: change, taskDefinition: "t", state });
    expect(result).toMatchObject({ assessed: false, reason: "too_few_failures", path: { kind: "continue" } });
    expect(result.state).toEqual(state);
    expect(sent).toEqual([]);
    expect(await listDecisionRecords(store, change)).toEqual([]);
  });

  test("a failure without an attempted fix is not assessed and nothing is sent", async () => {
    const { client, sent } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client });
    const state = failures(5, 2, { attemptedFix: (attempt) => (attempt === 1 ? "fix 1" : undefined) });
    const result = await assessRepairProgress({ runtime, store, changeName: change, taskDefinition: "t", state });
    expect(result).toMatchObject({ assessed: false, reason: "no_attempted_fix" });
    expect(sent).toEqual([]);
    expect(await listDecisionRecords(store, change)).toEqual([]);
  });

  test("an already assessed failure is not assessed twice", async () => {
    const { client, sent } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client });
    const first = await runRounds(runtime, store, 6, 1);
    const again = await assessRepairProgress({
      runtime, store, changeName: change, taskDefinition: "t", state: first.state,
    });
    expect(again).toMatchObject({ assessed: false, reason: "already_assessed" });
    expect(sent).toHaveLength(1);
  });
});

describe("enforce mode", () => {
  test("two stalled rounds escalate below the threshold, recording the supporting decision", async () => {
    const { client } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client, mode: "enforce" });
    const { state, results } = await runRounds(runtime, store, 6, 2);

    expect(results[0]).toMatchObject({ assessed: true, path: { kind: "continue" } });
    expect(results[1]).toMatchObject({ assessed: true, path: { kind: "escalate" } });
    expect(state.mode).toBe("systematic_debugging");
    expect(state.threshold).toBe(6);
    expect(state.assessments).toHaveLength(2);
    const records = await listDecisionRecords(store, change);
    expect(state.escalation).toMatchObject({ attempt: 3, recordId: results[1]!.assessed ? results[1]!.recordId : null });
    expect(records.find((record) => record.recordId === state.escalation!.recordId)).toMatchObject({
      decision: "debugging.thrash",
      acted: true,
      observed: { [THRASH_PATH_KEY]: "escalate", [THRASH_ATTEMPT_KEY]: 3 },
    });
  });

  test("a failure judged to need a human awaits the user", async () => {
    const { client } = scripted({ ...stalledAnswers, [ids.humanNeeded]: noul(0.92) });
    const { store, runtime } = await setup({ client, mode: "enforce" });
    const { state, results } = await runRounds(runtime, store, 6, 1);
    expect(results[0]).toMatchObject({ assessed: true, path: { kind: "await_user" } });
    expect(state.mode).toBe("ordinary_repair");
  });

  test("progress keeps the loop in ordinary repair", async () => {
    const { client } = scripted({ ...stalledAnswers, [ids.progress]: noul(0.7) });
    const { store, runtime } = await setup({ client, mode: "enforce" });
    const { state } = await runRounds(runtime, store, 6, 3);
    expect(state.mode).toBe("ordinary_repair");
    expect(state.escalation).toBeUndefined();
    expect(state.assessments).toHaveLength(3);
  });
});

describe("shadow mode", () => {
  test("transitions follow the count while the record shows what would have been decided", async () => {
    const { client } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client, mode: "shadow" });
    const { state, results } = await runRounds(runtime, store, 6, 2);

    expect(state.mode).toBe("ordinary_repair");
    expect(state.escalation).toBeUndefined();
    expect(state.assessments).toHaveLength(2);
    expect(results[1]).toMatchObject({ assessed: true, path: { kind: "continue" }, decided: { kind: "escalate" }, mode: "shadow" });
    const records = (await listDecisionRecords(store, change)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(records.map((record) => record.observed[THRASH_PATH_KEY])).toEqual(["continue", "escalate"]);
    expect(records.every((record) => record.mode === "shadow" && !record.acted)).toBe(true);
  });

  test("the eventual outcome is recorded against each decision", async () => {
    const { client } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client, mode: "shadow" });
    const { state } = await runRounds(runtime, store, 6, 2);
    await reconcileRepairOutcome({ store, changeName: change, state, status: "passed", attempt: 4 });

    const records = await listDecisionRecords(store, change);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.observed[THRASH_OUTCOME_KEY]).toEqual({ status: "passed", attempt: 4 });
    }
    const escalate = records.find((record) => record.observed[THRASH_PATH_KEY] === "escalate");
    expect(escalate?.wouldHaveActed).toBe(true);
  });
});

describe("unavailable judgment yields counting", () => {
  const clientReasons: JudgmentUnavailableReason[] = [
    "timeout", "rate_limit", "network", "server", "invalid_response", "model_mismatch", "aborted",
  ];

  async function assertCounting(runtime: JudgmentRuntime, store: AtomicJsonStore, threshold = 3) {
    const { state, results } = await runRounds(runtime, store, threshold, 2);
    expect(results.every((result) => !result.assessed && result.path.kind === "continue")).toBe(true);
    expect(state.assessments).toBeUndefined();
    expect(state.escalation).toBeUndefined();
    expect(state.mode).toBe("systematic_debugging");
    expect(state.failures).toHaveLength(3);
    return results;
  }

  for (const reason of clientReasons) {
    test(`${reason} leaves transitions to the count`, async () => {
      const { client } = scripted(stalledAnswers, reason);
      const { store, runtime } = await setup({ client });
      const results = await assertCounting(runtime, store);
      expect(results[0]).toMatchObject({ reason });
    });
  }

  test("an exhausted budget leaves transitions to the count and sends nothing", async () => {
    const { client, sent } = scripted(stalledAnswers);
    const budget = new BudgetLedger({ phases: { implementation: { totalTokens: 1 } } });
    const { store, runtime } = await setup({ client, budget });
    const results = await assertCounting(runtime, store);
    expect(results[0]).toMatchObject({ reason: "budget" });
    expect(sent).toEqual([]);
  });

  test("a state too large to send leaves transitions to the count and sends nothing", async () => {
    const { client, sent } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client });
    let state = failures(3, 1);
    state = recordUnexpectedFailure(state, {
      reproduction: "bun test",
      evidence: Array.from({ length: 200 }, (_, index) => `${index} ${"x".repeat(THRASH_EVIDENCE_BYTES - 10)}`),
      attemptedFix: "fix",
      recordedAt: at(2),
    });
    const result = await assessRepairProgress({ runtime, store, changeName: change, taskDefinition: "t", state });
    expect(result).toMatchObject({ assessed: false, reason: "state_too_large" });
    expect(result.state).toEqual(state);
    expect(sent).toEqual([]);
  });

  test("a gate that abstains leaves transitions to the count", async () => {
    const { client } = scripted({ [ids.changed]: noul(0.2) });
    const { store, runtime } = await setup({ client, mode: "enforce" });
    const state = failures(5, 2);
    const result = await assessRepairProgress({ runtime, store, changeName: change, taskDefinition: "t", state });
    expect(result).toMatchObject({ assessed: false, reason: "abstained" });
  });

  for (const [name, env] of [
    ["disabled", {}],
    ["not configured", { MUSTER_JEV: "1" }],
    ["invalidly configured", { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "k", MUSTER_JEV_MODE: "sometimes" }],
  ] as const) {
    test(`${name} judgment leaves transitions to the count and sends nothing`, async () => {
      const { client, sent } = scripted(stalledAnswers);
      const { store, runtime } = await setup({ client, env });
      await assertCounting(runtime, store);
      expect(sent).toEqual([]);
    });
  }

  test("disabled judgment sends nothing and writes no record", async () => {
    const { client, sent } = scripted(stalledAnswers);
    const { store } = await setup({ client });
    const result = await assessRepairProgress({
      runtime: createInertJudgmentRuntime(), store, changeName: change, taskDefinition: "t", state: failures(5, 3),
    });
    expect(result).toMatchObject({ assessed: false, reason: "disabled" });
    expect(sent).toEqual([]);
    expect(await listDecisionRecords(store, change)).toEqual([]);
  });
});

describe("failure text", () => {
  test("a bearer credential in evidence is redacted before it is sent", async () => {
    const { client, sent } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client });
    const state = failures(5, 2, { evidence: ["curl failed: Authorization: Bearer abc123.def456-secret returned 401"] });
    await assessRepairProgress({ runtime, store, changeName: change, taskDefinition: "t", state });
    const wire = JSON.stringify(sent[0]!.state);
    expect(wire).not.toContain("abc123.def456-secret");
    expect(wire).toContain("[REDACTED]");
  });

  test("long evidence, reproductions, and fixes are excerpted within their limits", () => {
    let state = failures(5, 1);
    state = recordUnexpectedFailure(state, {
      reproduction: "r".repeat(5_000),
      evidence: ["e".repeat(9_000), "short"],
      attemptedFix: "f".repeat(7_000),
      recordedAt: at(2),
    });
    const built = buildThrashInput(state, "t");
    if (!built.ok) throw new Error("expected input");
    const bytes = (text: string) => Buffer.byteLength(text, "utf8");
    expect(bytes(built.input.latest.reproduction)).toBeLessThanOrEqual(THRASH_REPRODUCTION_BYTES);
    expect(built.input.latest.evidence.every((item) => bytes(item) <= THRASH_EVIDENCE_BYTES)).toBe(true);
    expect(bytes(built.input.latest.attemptedFix)).toBeLessThanOrEqual(THRASH_ATTEMPTED_FIX_BYTES);
    expect(built.input.latest.evidence[1]).toBe("short");
    expect(built.input.latest.evidence[0]!.endsWith("…")).toBe(true);
  });

  test("multibyte text is excerpted without exceeding the byte limit", () => {
    let state = failures(5, 1);
    state = recordUnexpectedFailure(state, {
      reproduction: "bun test",
      evidence: ["é".repeat(3_000)],
      attemptedFix: "fix",
      recordedAt: at(2),
    });
    const built = buildThrashInput(state, "t");
    if (!built.ok) throw new Error("expected input");
    expect(Buffer.byteLength(built.input.latest.evidence[0]!, "utf8")).toBeLessThanOrEqual(THRASH_EVIDENCE_BYTES);
  });

  test("only the latest two failures are sent", async () => {
    const { client, sent } = scripted(stalledAnswers);
    const { store, runtime } = await setup({ client });
    await assessRepairProgress({ runtime, store, changeName: change, taskDefinition: "Fix the parser", state: failures(9, 4) });
    const wire = sent[0]!.state as { task: string; previousFailure: { attempt: number }; latestFailure: { attempt: number; attemptedFix: string } };
    expect(wire.task).toBe("Fix the parser");
    expect([wire.previousFailure.attempt, wire.latestFailure.attempt]).toEqual([3, 4]);
    expect(wire.latestFailure.attemptedFix).toBe("fix 4");
    expect(JSON.stringify(wire)).not.toContain("attempt 2");
  });
});

