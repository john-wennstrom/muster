import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type { JudgmentAnswers, JudgmentClient } from "../../src/judgment/client.ts";
import { TASK_ROUTING_MECHANICAL_ABOVE, TASK_ROUTING_NARROW_BELOW, TASK_ROUTING_REACH_BELOW, TASK_ROUTING_REACH_CONFIDENCE, TASK_ROUTING_RISK_BELOW, modelRoutingDecision, taskRoutingState } from "../../src/judgment/decisions/routing-task-model.ts";
import { judgmentCatalog, validateCatalog } from "../../src/judgment/catalog.ts";
import { validateDecision } from "../../src/judgment/decision.ts";
import {
  TASK_ROUTING_QUESTION_IDS as IDS,
  TASK_ROUTING_REACH_LEVELS,
  TASK_ROUTING_RISK_QUESTION_IDS,
} from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";

const gate = modelRoutingDecision.gate;
const noul = (value: number) => ({ type: "noul" as const, noul: value });
const scored = (score: number, confidence: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 1 - confidence },
  confidence,
});

/** A mechanical, low-risk, narrow task: the answers that let it run on the economy lane. */
function routable(overrides: JudgmentAnswers = {}): JudgmentAnswers {
  return {
    [IDS.mechanical]: noul(0.9),
    ...Object.fromEntries(TASK_ROUTING_RISK_QUESTION_IDS.map((id) => [id, noul(0.1)])),
    [IDS.reach]: scored(0.4, 0.9),
    ...overrides,
  };
}

describe("routing.task_model decision", () => {
  test("is registered, valid, gated by its own flag, and only reduces work", () => {
    expect(judgmentCatalog).toContain(modelRoutingDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
    expect(modelRoutingDecision.effects).toEqual(["reduces_work"]);
  });

  test("asks six yes/no questions and a four-level reach rubric", () => {
    const questions = validateDecision(modelRoutingDecision);
    expect(Object.keys(questions)).toHaveLength(7);
    const yesNo = Object.entries(questions).filter(([, question]) => question.type === "noul").map(([id]) => id).sort();
    expect(yesNo).toEqual([
      "changes_public_contract", "changes_security_boundary", "mechanical",
      "needs_deep_reasoning", "needs_large_context", "needs_novel_design",
    ]);
    const reach = questions[IDS.reach]!;
    expect(reach.type).toBe("score");
    expect(reach.type === "score" ? reach.criteria : []).toHaveLength(TASK_ROUTING_REACH_LEVELS.length);
    expect(TASK_ROUTING_REACH_LEVELS).toHaveLength(4);
  });
});

describe("routing.task_model gate", () => {
  test("the constants are the specified thresholds", () => {
    expect(TASK_ROUTING_MECHANICAL_ABOVE).toBe(0.8);
    expect(TASK_ROUTING_RISK_BELOW).toBe(0.3);
    expect(TASK_ROUTING_REACH_BELOW).toBe(1.5);
    expect(TASK_ROUTING_REACH_CONFIDENCE).toBe(0.8);
  });

  test("a mechanical low-risk narrow task is routed to the economy lane", () => {
    const outcome = gate(routable({
      [IDS.mechanical]: noul(0.9),
      ...Object.fromEntries(TASK_ROUTING_RISK_QUESTION_IDS.map((id) => [id, noul(0.15)])),
      [IDS.reach]: scored(1.0, 0.9),
    }));
    expect(outcome.act).toBe(true);
    if (!outcome.act) return;
    expect(outcome.value.lane).toBe("economy");
    expect(outcome.value.mechanical).toBe(0.9);
    expect(Object.keys(outcome.value.risks)).toEqual([...TASK_ROUTING_RISK_QUESTION_IDS]);
    expect(outcome.value.reach).toBe(1.0);
  });

  test("mechanical must be strictly above 0.8", () => {
    expect(gate(routable({ [IDS.mechanical]: noul(0.81) })).act).toBe(true);
    expect(gate(routable({ [IDS.mechanical]: noul(0.8) })).act).toBe(false);
    expect(gate(routable({ [IDS.mechanical]: noul(0.5) })).act).toBe(false);
  });

  test("each risk must be strictly below 0.3", () => {
    for (const id of TASK_ROUTING_RISK_QUESTION_IDS) {
      expect(gate(routable({ [id]: noul(0.29) })).act).toBe(true);
      expect(gate(routable({ [id]: noul(0.3) })).act).toBe(false);
      expect(gate(routable({ [id]: noul(0.5) })).act).toBe(false);
    }
  });

  test("a security-boundary task at 0.5 fails to route", () => {
    const outcome = gate(routable({ [IDS.securityBoundary]: noul(0.5) }));
    expect(outcome.act).toBe(false);
    if (!outcome.act) expect(outcome.reason).toContain(IDS.securityBoundary);
  });

  test("a public-contract task at 0.5 fails to route", () => {
    const outcome = gate(routable({ [IDS.publicContract]: noul(0.5) }));
    expect(outcome.act).toBe(false);
    if (!outcome.act) expect(outcome.reason).toContain(IDS.publicContract);
  });

  test("a wide-reach task at 2.0 fails to route, and reach must be strictly below 1.5", () => {
    expect(gate(routable({ [IDS.reach]: scored(2.0, 0.95) })).act).toBe(false);
    expect(gate(routable({ [IDS.reach]: scored(1.49, 0.9) })).act).toBe(true);
    expect(gate(routable({ [IDS.reach]: scored(1.5, 0.9) })).act).toBe(false);
  });

  test("reach confidence must be at least 0.8", () => {
    expect(gate(routable({ [IDS.reach]: scored(0.2, 0.8) })).act).toBe(true);
    expect(gate(routable({ [IDS.reach]: scored(0.2, 0.79) })).act).toBe(false);
  });

  test("an uncertain answer to any single guard fails to route", () => {
    for (const id of [IDS.mechanical, ...TASK_ROUTING_RISK_QUESTION_IDS]) {
      expect(gate(routable({ [id]: noul(0.5) })).act).toBe(false);
    }
    expect(gate(routable({ [IDS.reach]: scored(0.2, 0.5) })).act).toBe(false);
  });

  test("the reason names every guard that failed", () => {
    const outcome = gate(routable({ [IDS.mechanical]: noul(0.4), [IDS.novelDesign]: noul(0.9) }));
    expect(outcome.act).toBe(false);
    if (outcome.act) return;
    expect(outcome.reason).toContain(IDS.mechanical);
    expect(outcome.reason).toContain(IDS.novelDesign);
  });

  test("a missing, wrong-typed, or non-finite answer abstains", () => {
    for (const id of [IDS.mechanical, ...TASK_ROUTING_RISK_QUESTION_IDS, IDS.reach]) {
      const { [id]: _removed, ...without } = routable();
      expect(gate(without).act).toBe(false);
    }
    expect(gate(routable({ [IDS.mechanical]: scored(1, 0.9) })).act).toBe(false);
    expect(gate(routable({ [IDS.reach]: noul(0.1) })).act).toBe(false);
    expect(gate(routable({ [IDS.deepReasoning]: { type: "noul", noul: Number.NaN } })).act).toBe(false);
    expect(gate(routable({
      [IDS.reach]: { type: "score", score: Number.NaN, probabilities: {}, confidence: 0.9 },
    })).act).toBe(false);
    expect(gate({}).act).toBe(false);
  });
});

describe("routing.task_model thinking levels", () => {
  test("is version 2", () => {
    expect(modelRoutingDecision.version).toBe(2);
  });

  test("a narrow, mechanical, risk-free task gets builder low and reviewer medium", () => {
    const outcome = gate(routable({ [IDS.reach]: scored(0.4, 0.9) }));
    expect(outcome).toMatchObject({ act: true, value: { builderThinking: "low", reviewerThinking: "medium" } });
  });

  test("moderate reach gets builder medium and reviewer high", () => {
    const outcome = gate(routable({ [IDS.reach]: scored(1.0, 0.9) }));
    expect(outcome).toMatchObject({ act: true, value: { builderThinking: "medium", reviewerThinking: "high" } });
  });

  test("the narrow bound is strict", () => {
    expect(gate(routable({ [IDS.reach]: scored(TASK_ROUTING_NARROW_BELOW, 0.9) }))).toMatchObject({ value: { builderThinking: "medium" } });
  });

  test("an uncertain answer chooses nothing, so the caller keeps configured thinking", () => {
    expect(gate(routable({ [IDS.deepReasoning]: noul(0.5) })).act).toBe(false);
  });
});

describe("routing.task_model state", () => {
  test("holds exactly the task's description, requirements, scenarios, scopes, and verification", () => {
    const state = taskRoutingState({
      description: "Rename a flag",
      requirements: ["cli: Flag renamed"],
      scenarios: ["Renamed flag works"],
      reads: ["src/**"],
      writes: ["src/cli.ts"],
      verify: ["bun test"],
      // Anything beyond the contract, as a task object would carry, must not travel.
      ...({ id: "1.1", dependsOn: ["0.1"], manual: null } as object),
    });
    expect(state).toEqual({
      description: "Rename a flag",
      requirements: ["cli: Flag renamed"],
      scenarios: ["Renamed flag works"],
      reads: ["src/**"],
      writes: ["src/cli.ts"],
      verify: ["bun test"],
    });
  });
});

describe("routing.task_model enabling flag", () => {
  async function run(env: Record<string, string>) {
    const root = await mkdtemp(resolve(tmpdir(), "muster-routing-flag-"));
    try {
      const store = new AtomicJsonStore(root);
      let requests = 0;
      const client = {
        async request() {
          requests += 1;
          return { available: true, answers: routable(), model: "jev-1", inputTokens: 100, durationMs: 5 };
        },
      } as unknown as JudgmentClient;
      const runtime = createJudgmentRuntime({ env, store, client });
      const verdict = await runtime.judge(modelRoutingDecision, {
        input: modelRoutingDecision.representativeInput,
        changeName: "add-search",
        phase: "implementation",
        taskId: "1.1",
        state: taskRoutingState(modelRoutingDecision.representativeInput),
      });
      return { verdict, requests, records: await listDecisionRecords(store, "add-search") };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const base = { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce" };

  test("without judgment enabled nothing is sent", async () => {
    const result = await run({ MUSTER_JEV_MODE: "enforce" });
    expect(result.verdict).toEqual({ kind: "fallback", reason: "disabled", recordId: null });
    expect(result.requests).toBe(0);
    expect(result.records).toEqual([]);
  });

  test("with judgment enabled, enforce hands back the acting outcome and records the lane", async () => {
    const result = await run(base);
    expect(result.requests).toBe(1);
    expect(result.verdict.kind).toBe("enforce");
    expect(result.records).toHaveLength(1);
    const [record] = result.records;
    expect(record!.taskId).toBe("1.1");
    expect(record!.wouldHaveActed).toBe(true);
    expect(record!.acted).toBe(true);
    expect(record!.gate).toMatchObject({ act: true, value: { lane: "economy" } });
  });

  test("in shadow mode the lane is recorded and not handed back", async () => {
    const result = await run({ ...base, MUSTER_JEV_MODE: "shadow" });
    expect(result.verdict.kind).toBe("shadow");
    expect(result.records[0]!.wouldHaveActed).toBe(true);
    expect(result.records[0]!.acted).toBe(false);
  });
});
