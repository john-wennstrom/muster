import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleTaskCapsule, type AssembleTaskCapsuleOptions, type ContextSlice } from "../../src/context/assembler.ts";
import {
  MAX_RANKED_SLICES,
  MAX_SLICE_EXCERPT_BYTES,
  rankCapsuleSlices,
  reconcileCapsuleEscalations,
  slicesToRank,
} from "../../src/context/ranking.ts";
import { createInertJudgmentRuntime, createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type {
  JudgmentAnswers,
  JudgmentClient,
  JudgmentClientRequest,
  JudgmentUnavailableReason,
} from "../../src/judgment/client.ts";
import { createDeadClient } from "../../src/judgment/replay.ts";
import { capsuleRankingQuestionId } from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const change = "judgment-capsule-ranking";
const env = (mode: "shadow" | "enforce") => ({ MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "sk-test", MUSTER_JEV_MODE: mode });

const contract = {
  taskId: "9.3",
  definition: "Rank task context.",
  requirements: ["Ranking orders slices"],
  scenarios: [],
  decisions: [],
  readScopes: ["src/context/**"],
  writeScopes: ["src/context/**"],
  acceptance: [],
  tokenBudget: 100,
};

const relevant = (id: string, tokenEstimate: number, extra: Partial<ContextSlice> = {}): ContextSlice => ({
  id,
  priority: "relevant",
  content: `content of ${id}`,
  tokenEstimate,
  ...extra,
});

const assembly = (slices: readonly ContextSlice[]): AssembleTaskCapsuleOptions => ({
  contract,
  requiredTokenEstimate: 40,
  slices,
});

const score = (value: number, confidence: number) => ({
  type: "score" as const,
  score: value,
  probabilities: { "0": 0.5 },
  confidence,
});

/** A client that answers each slice question from a list of [score, confidence], by slice position. */
function scripted(rankings: readonly (readonly [number, number])[]) {
  const sent: JudgmentClientRequest[] = [];
  const client: JudgmentClient = {
    async request(request) {
      sent.push(request);
      const answers: JudgmentAnswers = Object.fromEntries(
        rankings.map(([value, confidence], position) => [capsuleRankingQuestionId(position + 1), score(value, confidence)]),
      );
      return { available: true, answers, model: "jev-1.13.0", inputTokens: 500, outputTokens: 0, durationMs: 5 };
    },
  };
  return { client, sent };
}

async function setup(mode: "shadow" | "enforce", client: JudgmentClient) {
  const root = await mkdtemp(join(tmpdir(), "capsule-ranking-"));
  directories.push(root);
  const store = new AtomicJsonStore(root);
  return { store, runtime: createJudgmentRuntime({ env: env(mode), store, client }) };
}

const slices = [relevant("first", 40), relevant("second", 40)];

describe("rankCapsuleSlices", () => {
  test("enforce mode returns a ranking keyed by slice identifier that the assembler packs by", async () => {
    const { client, sent } = scripted([[1, 0.9], [2.8, 0.9]]);
    const { store, runtime } = await setup("enforce", client);
    const options = assembly(slices);
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: options });
    expect(result.ranking).toEqual({ first: { score: 1, confidence: 0.9 }, second: { score: 2.8, confidence: 0.9 } });
    expect(result.recordId).not.toBeNull();
    const capsule = assembleTaskCapsule({ ...options, ranking: result.ranking });
    expect(capsule.included.map((slice) => slice.id)).toEqual(["task-contract", "second"]);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.questions)).toEqual(["slice_1_necessity", "slice_2_necessity"]);
  });

  test("the state holds the contract and bounded excerpts, and slice paths are declared for the denylist", async () => {
    const { client, sent } = scripted([[2, 0.9]]);
    const { store, runtime } = await setup("enforce", client);
    const long = relevant("long", 10, { path: "src/context/long.ts", content: "é".repeat(1000) });
    await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly([long]) });
    const state = sent[0]!.state as { slices: { index: number; path: string; excerpt: string }[] };
    expect(state.slices).toHaveLength(1);
    expect(state.slices[0]!.path).toBe("src/context/long.ts");
    expect(Buffer.byteLength(state.slices[0]!.excerpt, "utf8")).toBeLessThanOrEqual(MAX_SLICE_EXCERPT_BYTES);
    expect((sent[0]!.state as { task: { definition: string } }).task.definition).toBe(contract.definition);
  });

  test("a slice path the credential denylist names makes the ranking unavailable without a request", async () => {
    const { client, sent } = scripted([[2, 0.9]]);
    const { store, runtime } = await setup("enforce", client);
    const secret = relevant("env", 10, { path: ".env" });
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly([secret]) });
    expect(result.ranking).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  test("slices beyond thirty are unscored and only excerpts of thirty are sent", async () => {
    const many = Array.from({ length: 35 }, (_, index) => relevant(`s${index}`, 1));
    expect(slicesToRank(many)).toHaveLength(MAX_RANKED_SLICES);
    const { client, sent } = scripted(Array.from({ length: 35 }, () => [2, 0.9] as const));
    const { store, runtime } = await setup("enforce", client);
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly(many) });
    expect(Object.keys(sent[0]!.questions)).toHaveLength(MAX_RANKED_SLICES);
    expect(Object.keys(result.ranking ?? {})).toHaveLength(MAX_RANKED_SLICES);
    expect(result.ranking).not.toHaveProperty("s30");
  });

  test("only relevant slices are ranked, and none means no request", async () => {
    const { client, sent } = scripted([[2, 0.9]]);
    const { store, runtime } = await setup("enforce", client);
    const none = [{ id: "a", priority: "available" as const, content: "x", tokenEstimate: 1 }];
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly(none) });
    expect(result).toEqual({ ranking: undefined, recordId: null });
    expect(sent).toHaveLength(0);
  });

  test("an abstaining gate yields no ranking", async () => {
    const { client } = scripted([]);
    const { store, runtime } = await setup("enforce", client);
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly(slices) });
    expect(result.ranking).toBeUndefined();
  });

  const reasons: JudgmentUnavailableReason[] = [
    "budget", "state_denied", "state_too_large", "timeout", "rate_limit", "network",
    "server", "invalid_response", "model_mismatch", "aborted",
  ];
  test.each(reasons)("unavailable reason %s yields no ranking and so the unranked capsule", async (reason) => {
    const { store, runtime } = await setup("enforce", createDeadClient(reason));
    const options = assembly(slices);
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: options });
    expect(result.ranking).toBeUndefined();
    expect(assembleTaskCapsule({ ...options, ranking: result.ranking })).toEqual(assembleTaskCapsule(options));
  });

  test("a client that throws does not fail the step", async () => {
    const client: JudgmentClient = { async request() { throw new Error("boom"); } };
    const { store, runtime } = await setup("enforce", client);
    expect((await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly(slices) })).ranking).toBeUndefined();
  });

  test("disabled judgment builds and sends nothing and writes no record", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-ranking-"));
    directories.push(root);
    const store = new AtomicJsonStore(root);
    const { client, sent } = scripted([[2, 0.9]]);
    const disabled = [
      createInertJudgmentRuntime(),
      createJudgmentRuntime({ env: {}, store, client }),
    ];
    for (const runtime of disabled) {
      expect(await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly(slices) }))
        .toEqual({ ranking: undefined, recordId: null });
    }
    expect(sent).toHaveLength(0);
    expect(await listDecisionRecords(store, change)).toEqual([]);
  });
});

describe("shadow mode", () => {
  test("returns nothing to act on and records what ranking would have done", async () => {
    const { client } = scripted([[1, 0.9], [2.8, 0.9], [0.1, 0.9]]);
    const { store, runtime } = await setup("shadow", client);
    const options = assembly([relevant("first", 40), relevant("second", 40), relevant("noise", 5)]);
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: options });
    expect(result.ranking).toBeUndefined();
    expect(assembleTaskCapsule({ ...options, ranking: result.ranking })).toEqual(assembleTaskCapsule(options));

    const [record] = await listDecisionRecords(store, change);
    expect(record!.recordId).toBe(result.recordId!);
    expect(record!.observed).toEqual({
      baselineIncluded: ["first", "noise"],
      wouldInclude: ["second"],
      wouldDemote: ["noise"],
      wouldListOversized: [],
      differs: true,
    });
  });

  test("lists an oversized required slice in the counterfactual", async () => {
    const { client } = scripted([[2.9, 0.9]]);
    const { store, runtime } = await setup("shadow", client);
    await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly([relevant("huge", 90)]) });
    const [record] = await listDecisionRecords(store, change);
    expect(record!.observed).toMatchObject({ wouldListOversized: ["huge"], wouldInclude: [], differs: true });
  });

  test("records that the capsule would not differ when ranking agrees with list order", async () => {
    const { client } = scripted([[2, 0.9], [1, 0.9]]);
    const { store, runtime } = await setup("shadow", client);
    await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly([relevant("a", 10), relevant("b", 10)]) });
    const [record] = await listDecisionRecords(store, change);
    expect(record!.observed).toMatchObject({ differs: false, wouldInclude: ["a", "b"] });
  });

  test("escalations reconcile with the counterfactual, merging repeated calls", async () => {
    const { client } = scripted([[1, 0.9], [2.8, 0.9]]);
    const { store, runtime } = await setup("shadow", client);
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly(slices) });
    // Baseline packs "first" and leaves "second" out, so a builder escalates for "second".
    expect(await reconcileCapsuleEscalations(store, change, result.recordId!, ["second"])).toEqual({ found: true });
    expect(await reconcileCapsuleEscalations(store, change, result.recordId!, ["second", "extra"])).toEqual({ found: true });
    const [record] = await listDecisionRecords(store, change);
    expect(record!.observed.escalations).toEqual([
      { sourceId: "second", wouldHaveBeenIncluded: true },
      { sourceId: "extra", wouldHaveBeenIncluded: false },
    ]);
    expect(record!.observed.escalationsRankingWouldHaveAvoided).toBe(1);
  });

  test("a record that is missing, or that has no counterfactual, is reported as not found", async () => {
    const { client } = scripted([[1, 0.9]]);
    const { store, runtime } = await setup("enforce", client);
    const result = await rankCapsuleSlices({ runtime, store, changeName: change, assembly: assembly(slices) });
    expect(await reconcileCapsuleEscalations(store, change, "decision-missing", ["a"])).toEqual({ found: false });
    expect(await reconcileCapsuleEscalations(store, change, result.recordId!, ["a"])).toEqual({ found: false });
  });
});
