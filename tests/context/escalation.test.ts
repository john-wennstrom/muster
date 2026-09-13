import { describe, expect, test } from "bun:test";
import { createDecisionCapsule } from "../../src/agents/reports.ts";
import { assembleTaskCapsule } from "../../src/context/assembler.ts";
import { escalateContext } from "../../src/context/escalation.ts";

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