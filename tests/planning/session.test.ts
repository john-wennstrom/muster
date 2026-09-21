import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import type { ReadAgentOptions } from "../../src/agents/spawn.ts";
import { listChangeUsage } from "../../src/persistence/change-usage-store.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { isRenderedPrompt } from "../../src/prompts/render.ts";
import { renderDebatePrompt, renderOpinionPrompt, renderPlanPrompt, renderRequiredChanges } from "../../src/planning/prompts.ts";
import { runPlanningSession, thinkingForPlanning, type PlanningSessionOptions } from "../../src/planning/session.ts";
import { BudgetLedger } from "../../src/telemetry/budget.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const input = {
  changeName: "add-search",
  request: "Add a search box",
  lane: "small" as const,
  authoritativeContext: { changeRoot: "/repo/openspec/changes/add-search" },
};

describe("planning prompts", () => {
  test("small guidance is present, with the lane's task limit", () => {
    const prompt = renderPlanPrompt(input);
    expect(isRenderedPrompt(prompt)).toBeTrue();
    expect(prompt).toContain("This is a small change.");
    expect(prompt).toContain("Use at most 2 tasks.");
    expect(prompt).not.toContain("This is a large change.");
  });

  test("each lane has its own guidance and limit", () => {
    expect(renderPlanPrompt({ ...input, lane: "medium" })).toContain("This is a medium change.");
    const large = renderPlanPrompt({ ...input, lane: "large" });
    expect(large).toContain("This is a large change.");
    expect(large).toContain("Use at most 40 tasks.");
  });

  test("the prompt carries the schema the answer is validated against", () => {
    const prompt = renderPlanPrompt(input);
    expect(prompt).toContain('"needs_clarification"');
    expect(prompt).toContain('"already_satisfied"');
    expect(prompt).toContain("Return exactly one JSON object");
  });

  test("required changes from a revising review are folded in", () => {
    const required = renderRequiredChanges({
      round: 2,
      requiredChanges: ["Handle the empty-query case explicitly."],
      criticalFindings: ["Scenario names collide."],
    });
    const prompt = renderPlanPrompt({ ...input, requiredChanges: required });
    expect(prompt).toContain("The most recent planning review (round 2) requested REVISE.");
    expect(prompt).toContain("- Handle the empty-query case explicitly.");
    expect(prompt).toContain("Critical findings:\n- Scenario names collide.");
  });

  test("refinement shows the current artifacts and asks for a whole plan", () => {
    const prompt = renderPlanPrompt({ ...input, currentArtifacts: [{ path: "proposal.md", content: "# Proposal\n\nOld." }] });
    expect(prompt).toContain("FILE proposal.md\n# Proposal\n\nOld.");
    expect(prompt).toContain("Refinement returns a whole revised plan");
  });

  test("the retry names the failures", () => {
    const prompt = renderPlanPrompt({ ...input, validationFailures: '- tasks[0].verify[0]: executable "cargo" is not allowed' });
    expect(prompt).toContain("Your previous answer was rejected.");
    expect(prompt).toContain('- tasks[0].verify[0]: executable "cargo" is not allowed');
    expect(renderPlanPrompt(input)).not.toContain("Your previous answer was rejected.");
  });

  test("a confident triage tells the session to return a plan", () => {
    expect(renderPlanPrompt({ ...input, triageProceeds: true })).toContain("Triage has already judged");
    expect(renderPlanPrompt(input)).not.toContain("Triage has already judged");
  });

  test("prior analysis from opinions and a debate is included, and an empty block leaves no gap", () => {
    const prompt = renderPlanPrompt({ ...input, lane: "large", priorAnalysis: [{ model: "openai/gpt-test", content: "Prefer a debounce." }] });
    expect(prompt).toContain("RESULT 1 (openai/gpt-test)\nPrefer a debounce.");
    expect(renderPlanPrompt(input)).not.toMatch(/\n\n\n/);
  });

  test("opinions and the debate have their own prompts", () => {
    expect(renderOpinionPrompt(input)).toContain("one of several specialists");
    const debate = renderDebatePrompt({ ...input, priorAnalysis: [{ model: "a/b", content: "Opinion." }] });
    expect(debate).toContain("Specialists have analysed this change independently.");
    expect(debate).toContain("RESULT 1 (a/b)\nOpinion.");
  });
});

describe("thinkingForPlanning", () => {
  test("direct work is low, bounded is medium, architectural keeps the configured level", () => {
    expect(thinkingForPlanning("direct", "high")).toBe("low");
    expect(thinkingForPlanning("bounded", "high")).toBe("medium");
    expect(thinkingForPlanning("architectural", "xhigh")).toBe("xhigh");
  });
});

describe("runPlanningSession", () => {
  async function setup(text: string, exitCode = 0) {
    const root = await mkdtemp(resolve(tmpdir(), "muster-planning-session-"));
    directories.push(root);
    const usageStore = new AtomicJsonStore(root);
    const seen: ReadAgentOptions[] = [];
    const stack = synthesizeLegacyStack({
      architectModel: "openai/architect",
      builderModel: "openai/builder",
      architectThinking: "high",
      builderThinking: "medium",
    });
    const options: PlanningSessionOptions = {
      cwd: root,
      changeName: "add-search",
      phase: "propose",
      runId: "propose-add-search",
      stack,
      slot: stack.architect,
      classification: "direct",
      usageStore,
      budget: new BudgetLedger({ phases: { planning: { totalTokens: 1_000_000 } } }),
      runChild: async (child) => {
        seen.push(child);
        child.run.text = text;
        child.run.exitCode = exitCode;
        child.run.tokensIn = 1_000;
        child.run.tokensOut = 200;
        child.run.status = exitCode === 0 ? "done" : "failed";
        return child.run;
      },
    };
    return { options, seen, usageStore, root };
  }

  test("runs one read-only architect session through the spawn entry point and returns its answer", async () => {
    const { options, seen } = await setup("the plan");
    const answer = await runPlanningSession("plan", input, options);
    expect(answer).toBe("the plan");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      access: "read",
      role: "architect",
      taskId: "planning.synthesis",
      thinking: "low",
      toolMode: "standard",
      timeoutMs: 30 * 60 * 1000,
    });
    expect(seen[0]!.sessionDir).toContain(resolve(options.cwd, ".fusion", "runs", "propose-add-search", "sessions", "synthesis-"));
    expect(isRenderedPrompt(seen[0]!.prompt)).toBeTrue();
    expect(seen[0]!.maxRequests).toBeUndefined();
  });

  test("opinions and the debate use their own stage names", async () => {
    const { options, seen } = await setup("analysis");
    await runPlanningSession("opinion", input, options);
    await runPlanningSession("debate", input, options);
    expect(seen.map((child) => child.taskId)).toEqual(["planning.specialist_opinion", "planning.debate"]);
  });

  test("usage is recorded and charged to the planning budget", async () => {
    const { options, usageStore } = await setup("the plan");
    await runPlanningSession("plan", input, options);
    const records = await listChangeUsage(usageStore, "add-search");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: "planning", inputTokens: 1_000, outputTokens: 200 });
    const forecast = options.budget.forecast({ phase: "planning", role: "architect", activity: "synthesis", estimate: { totalTokens: 0, costUsd: 0 } });
    expect(forecast.scopes.find(({ scope }) => scope.level === "phase")?.used.totalTokens).toBeGreaterThan(0);
  });

  test("a session that fails still records its usage and fails the command with the reason", async () => {
    const { options, usageStore } = await setup("", 1);
    await expect(runPlanningSession("plan", input, options)).rejects.toMatchObject({ code: "PLANNING_AGENT_FAILED" });
    expect(await listChangeUsage(usageStore, "add-search")).toHaveLength(1);
  });
});
