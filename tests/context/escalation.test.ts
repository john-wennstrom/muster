import { describe, expect, test } from "bun:test";
import { createDecisionCapsule } from "../../src/agents/reports.ts";
import { assembleTaskCapsule } from "../../src/context/assembler.ts";
import { authorizeFromRanking, escalateContext } from "../../src/context/escalation.ts";

const capsule = assembleTaskCapsule({
  contract: {
    taskId: "8.3",
    definition: "Add context escalation.",
    requirements: ["Escalation is authorized"],
    scenarios: ["Builder needs omitted context"],
    decisions: [],
    readScopes: ["src/context/**"],
    writeScopes: ["src/context/**"],
    acceptance: ["Denied requests are explicit"],
    tokenBudget: 100,
  },
  requiredTokenEstimate: 50,
  slices: [
    { id: "parser-source", priority: "available", content: "export function parse() {}", tokenEstimate: 20 },
    { id: "unrelated-transcript", priority: "excluded", content: "private conversation", tokenEstimate: 10 },
  ],
});

describe("context escalation", () => {
  test("authorizes available context and records estimated usage", async () => {
    const result = await escalateContext({
      capsule,
      request: {
        runId: "run-1",
        taskId: "8.3",
        sourceId: "parser-source",
        reason: "Need the parser interface",
        remainingTokens: 25,
      },
      sources: {
        "parser-source": { id: "parser-source", content: "export function parse() {}", tokenEstimate: 20 },
      },
      authorize: async (_request, source) => source.id === "parser-source",
    });

    expect(result).toEqual({
      allowed: true,
      sourceId: "parser-source",
      content: "export function parse() {}",
      usage: {
        schemaVersion: 1,
        runId: "run-1",
        taskId: "8.3",
        sourceId: "parser-source",
        inputTokens: 20,
        measurement: "estimated",
      },
    });
  });

  test("explicitly denies excluded, unauthorized, and over-budget requests", async () => {
    const request = {
      runId: "run-1",
      taskId: "8.3",
      reason: "Need more context",
      remainingTokens: 25,
    };
    const sources = {
      "parser-source": { id: "parser-source", content: "parser", tokenEstimate: 20 },
      "unrelated-transcript": { id: "unrelated-transcript", content: "private conversation", tokenEstimate: 10 },
    };

    const excluded = await escalateContext({
      capsule,
      request: { ...request, sourceId: "unrelated-transcript" },
      sources,
      authorize: () => true,
    });
    const denied = await escalateContext({
      capsule,
      request: { ...request, sourceId: "parser-source" },
      sources,
      authorize: () => false,
    });
    const overBudget = await escalateContext({
      capsule,
      request: { ...request, sourceId: "parser-source", remainingTokens: 10 },
      sources,
      authorize: () => true,
    });

    expect(excluded).toMatchObject({ allowed: false, reason: "Requested context is explicitly excluded" });
    expect(denied).toMatchObject({ allowed: false, reason: "Requested context is not authorized for this task" });
    expect(overBudget).toMatchObject({ allowed: false, reason: expect.stringContaining("only 10 remain") });
    expect(JSON.stringify([excluded, denied, overBudget])).not.toContain("private conversation");
  });

  test("validates compact decision capsules and rejects transcript fields", () => {
    const decision = createDecisionCapsule({
      schemaVersion: 1,
      runId: "run-1",
      decisionId: "decision-1",
      summary: "Use structured context escalation.",
      rationale: "It preserves authorization and usage evidence.",
      affectedTasks: ["8.3"],
      createdAt: "2026-09-12T12:00:00.000Z",
    });
    expect(decision.affectedTasks).toEqual(["8.3"]);
    expect(() => createDecisionCapsule({ ...decision, transcript: "private" } as never)).toThrow();
  });
});
describe("ranking-based escalation authorization", () => {
  const ranked = assembleTaskCapsule({
    contract: {
      taskId: "9.2",
      definition: "Authorize from a ranking.",
      requirements: [],
      scenarios: [],
      decisions: [],
      readScopes: ["src/context/**"],
      writeScopes: ["src/context/**"],
      acceptance: [],
      tokenBudget: 100,
    },
    requiredTokenEstimate: 50,
    slices: [
      { id: "useful", priority: "relevant", content: "useful source", tokenEstimate: 60 },
      { id: "background", priority: "relevant", content: "background source", tokenEstimate: 60 },
      { id: "unscored", priority: "available", content: "unscored source", tokenEstimate: 10 },
      { id: "secret", priority: "excluded", content: "private", tokenEstimate: 10 },
    ],
    ranking: {
      useful: { score: 1.5, confidence: 0.6 },
      background: { score: 1.4, confidence: 0.9 },
      secret: { score: 3, confidence: 1 },
    },
  });
  const sources = Object.fromEntries(
    ["useful", "background", "unscored", "secret"].map((id) => [id, { id, content: `${id} source`, tokenEstimate: id === "unscored" || id === "secret" ? 10 : 60 }]),
  );
  const request = (sourceId: string, remainingTokens = 100) => ({
    runId: "run-1", taskId: "9.2", sourceId, reason: "Need it", remainingTokens,
  });
  const ask = (sourceId: string, remainingTokens?: number) => escalateContext({
    capsule: ranked,
    request: request(sourceId, remainingTokens),
    sources,
    authorize: authorizeFromRanking(ranked),
  });

  test("the fixture lists the ranked slices as available", () => {
    expect(ranked.available).toEqual(["useful", "background", "unscored"]);
  });

  test("a ranked available slice at the bar is authorized", async () => {
    expect(await ask("useful")).toMatchObject({ allowed: true, sourceId: "useful" });
  });

  test("a ranked available slice below the bar is not authorized", async () => {
    expect(await ask("background")).toMatchObject({ allowed: false, reason: "Requested context is not authorized for this task" });
  });

  test("an excluded slice the ranking scored required is refused", async () => {
    expect(await ask("secret")).toMatchObject({ allowed: false, reason: "Requested context is explicitly excluded" });
  });

  test("an unranked available slice is not authorized by the ranking", async () => {
    expect(await ask("unscored")).toMatchObject({ allowed: false, reason: "Requested context is not authorized for this task" });
  });

  test("unknown and over-budget requests are refused before the ranking is consulted", async () => {
    let consulted = 0;
    const spy = (capsule: typeof ranked) => {
      const authorize = authorizeFromRanking(capsule);
      return (...args: Parameters<typeof authorize>) => { consulted += 1; return authorize(...args); };
    };
    const unknown = await escalateContext({ capsule: ranked, request: request("missing"), sources, authorize: spy(ranked) });
    const overBudget = await escalateContext({ capsule: ranked, request: request("useful", 10), sources, authorize: spy(ranked) });
    expect(unknown).toMatchObject({ allowed: false, reason: "Requested context is not available to this task" });
    expect(overBudget).toMatchObject({ allowed: false, reason: expect.stringContaining("only 10 remain") });
    expect(consulted).toBe(0);
  });

  test("the callback alone does not approve a source outside the capsule's available set or budget", () => {
    const authorize = authorizeFromRanking(ranked);
    expect(authorize(request("secret"), sources.secret!)).toBe(false);
    expect(authorize(request("useful", 10), sources.useful!)).toBe(false);
  });

  test("a capsule without a ranking authorizes nothing", async () => {
    const plain = assembleTaskCapsule({
      contract: { taskId: "9.2", definition: "d", requirements: [], scenarios: [], decisions: [], readScopes: [], writeScopes: [], acceptance: [], tokenBudget: 100 },
      requiredTokenEstimate: 10,
      slices: [{ id: "unscored", priority: "available", content: "x", tokenEstimate: 10 }],
    });
    expect(authorizeFromRanking(plain)(request("unscored"), sources.unscored!)).toBe(false);
  });
});
