import { describe, expect, test } from "bun:test";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type { JudgmentAnswers, JudgmentClient } from "../../src/judgment/client.ts";
import {
  REVIEW_TRIAGE_CHANGE_BELOW,
  REVIEW_TRIAGE_CONFIDENCE_AT_LEAST,
  REVIEW_TRIAGE_ENABLE_VARIABLE,
  REVIEW_TRIAGE_MATERIALITY_BELOW,
  judgmentCatalog,
  reviewTriageDecision,
  reviewTriageState,
  validateCatalog,
  validateDecision,
} from "../../src/judgment/gates.ts";
import {
  REVIEW_TRIAGE_CHANGE_QUESTION_IDS,
  REVIEW_TRIAGE_MATERIALITY_LEVELS,
  REVIEW_TRIAGE_QUESTION_IDS,
} from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const gate = reviewTriageDecision.gate;
const noul = (value: number) => ({ type: "noul" as const, noul: value });
const scored = (score: number, confidence: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 1 - confidence },
  confidence,
});

/** A wording-only edit that changed nothing: the answers that let an approval be carried. */
function clean(overrides: JudgmentAnswers = {}): JudgmentAnswers {
  return {
    [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(0, 0.95),
    ...Object.fromEntries(REVIEW_TRIAGE_CHANGE_QUESTION_IDS.map((id) => [id, noul(0.05)])),
    ...overrides,
  };
}

describe("review.triage decision", () => {
  test("is registered, valid, gated by its own flag, and only reduces work", () => {
    expect(judgmentCatalog).toContain(reviewTriageDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
    expect(reviewTriageDecision.effects).toEqual(["reduces_work"]);
    expect(reviewTriageDecision.enabledBy).toBe("MUSTER_JEV_REVIEW_TRIAGE");
    expect(REVIEW_TRIAGE_ENABLE_VARIABLE).toBe("MUSTER_JEV_REVIEW_TRIAGE");
  });

  test("asks a four-level materiality rubric and five yes/no questions", () => {
    const questions = validateDecision(reviewTriageDecision);
    expect(Object.keys(questions)).toHaveLength(6);
    const materiality = questions[REVIEW_TRIAGE_QUESTION_IDS.materiality]!;
    expect(materiality.type).toBe("score");
    expect(materiality.type === "score" ? materiality.criteria : []).toHaveLength(REVIEW_TRIAGE_MATERIALITY_LEVELS.length);
    expect(REVIEW_TRIAGE_MATERIALITY_LEVELS).toHaveLength(4);
    for (const id of REVIEW_TRIAGE_CHANGE_QUESTION_IDS) expect(questions[id]!.type).toBe("noul");
    expect([...REVIEW_TRIAGE_CHANGE_QUESTION_IDS].sort()).toEqual([
      "changes_requirements", "changes_scenarios", "changes_scopes", "changes_tasks", "contradicts_approval",
    ]);
  });
});

describe("review.triage gate", () => {
  test("carries forward a confident wording-only edit that changed nothing", () => {
    const outcome = gate(clean());
    expect(outcome.act).toBe(true);
    if (!outcome.act) return;
    expect(outcome.value.materiality).toBe(0);
    expect(outcome.value.materialityConfidence).toBe(0.95);
    expect(Object.keys(outcome.value.changes)).toEqual([...REVIEW_TRIAGE_CHANGE_QUESTION_IDS]);
  });

  test("the constants are the specified thresholds", () => {
    expect(REVIEW_TRIAGE_MATERIALITY_BELOW).toBe(1.5);
    expect(REVIEW_TRIAGE_CONFIDENCE_AT_LEAST).toBe(0.85);
    expect(REVIEW_TRIAGE_CHANGE_BELOW).toBe(0.25);
  });

  test("materiality must be strictly below 1.5", () => {
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(1.0, 0.9) })).act).toBe(true);
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(1.49, 0.9) })).act).toBe(true);
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(1.5, 0.9) })).act).toBe(false);
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(3, 0.99) })).act).toBe(false);
  });

  test("materiality confidence must be at least 0.85", () => {
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(0, 0.85) })).act).toBe(true);
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(0, 0.84) })).act).toBe(false);
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(0, 0.7) })).act).toBe(false);
  });

  test("each yes/no probability must be strictly below 0.25", () => {
    for (const id of REVIEW_TRIAGE_CHANGE_QUESTION_IDS) {
      expect(gate(clean({ [id]: noul(0.24) })).act).toBe(true);
      expect(gate(clean({ [id]: noul(0.25) })).act).toBe(false);
      expect(gate(clean({ [id]: noul(0.4) })).act).toBe(false);
    }
  });

  test("added requirement text is not carried forward", () => {
    const outcome = gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.requirements]: noul(0.4) }));
    expect(outcome.act).toBe(false);
  });

  test("a missing, wrong-typed, or non-finite answer abstains", () => {
    for (const id of [REVIEW_TRIAGE_QUESTION_IDS.materiality, ...REVIEW_TRIAGE_CHANGE_QUESTION_IDS]) {
      const { [id]: _removed, ...without } = clean();
      expect(gate(without).act).toBe(false);
    }
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: noul(0) })).act).toBe(false);
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.tasks]: scored(0, 0.9) })).act).toBe(false);
    expect(gate(clean({ [REVIEW_TRIAGE_QUESTION_IDS.tasks]: { type: "noul", noul: Number.NaN } })).act).toBe(false);
    expect(gate(clean({
      [REVIEW_TRIAGE_QUESTION_IDS.materiality]: { type: "score", score: Number.NaN, probabilities: {}, confidence: 0.9 },
    })).act).toBe(false);
    expect(gate({}).act).toBe(false);
  });
});

describe("review.triage state", () => {
  test("holds only the two diffs and the recommendations", () => {
    const state = reviewTriageState({
      proposalDiff: "@@ -1 +1 @@\n-a\n+b\n",
      designDiff: "",
      recommendations: ["Keep it small."],
    });
    expect(state).toEqual({
      proposalDiff: "@@ -1 +1 @@\n-a\n+b\n",
      designDiff: "",
      previousRecommendations: ["Keep it small."],
    });
    expect(Object.keys(state as object).sort()).toEqual(["designDiff", "previousRecommendations", "proposalDiff"]);
  });
});

describe("review.triage enabling flag", () => {
  const answering = (answers: JudgmentAnswers): JudgmentClient => ({
    async request() {
      return { available: true, answers, model: "jev-1", inputTokens: 100, durationMs: 5 };
    },
  }) as unknown as JudgmentClient;

  async function run(env: Record<string, string>) {
    const root = await mkdtemp(resolve(tmpdir(), "muster-triage-flag-"));
    try {
      const store = new AtomicJsonStore(root);
      let requests = 0;
      const client = answering(clean());
      const counting: JudgmentClient = { request: (...args) => { requests += 1; return client.request(...args); } } as JudgmentClient;
      const runtime = createJudgmentRuntime({ env, store, client: counting });
      const verdict = await runtime.judge(reviewTriageDecision, {
        input: reviewTriageDecision.representativeInput,
        changeName: "add-search",
        phase: "planning",
        state: reviewTriageState(reviewTriageDecision.representativeInput),
      });
      return { verdict, requests, records: await listDecisionRecords(store, "add-search") };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const base = { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce" };

  test("judgment without the triage flag sends nothing and falls back", async () => {
    const result = await run(base);
    expect(result.verdict).toEqual({ kind: "fallback", reason: "disabled", recordId: null });
    expect(result.requests).toBe(0);
    expect(result.records).toEqual([]);
  });

  test("with the flag, enforce mode hands back the acting outcome", async () => {
    const result = await run({ ...base, MUSTER_JEV_REVIEW_TRIAGE: "1" });
    expect(result.requests).toBe(1);
    expect(result.verdict.kind).toBe("enforce");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.wouldHaveActed).toBe(true);
  });

  test("with the flag in shadow mode, the outcome is recorded and not handed back", async () => {
    const result = await run({ ...base, MUSTER_JEV_MODE: "shadow", MUSTER_JEV_REVIEW_TRIAGE: "1" });
    expect(result.verdict.kind).toBe("shadow");
    expect(result.records[0]!.wouldHaveActed).toBe(true);
    expect(result.records[0]!.acted).toBe(false);
  });
});
