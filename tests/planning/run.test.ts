import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import { runProductionPlanning, type ProductionPlanningOptions } from "../../src/change/phases/planning.ts";
import type { Candidate } from "../../src/context/candidates.ts";
import { readLane } from "../../src/controller/lane.ts";
import { createInertJudgmentRuntime, createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecStatus } from "../../src/openspec/protocol.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import type { PlanningPromptInput } from "../../src/planning/prompts.ts";
import type { PlanningSessionKind } from "../../src/planning/session.ts";
import { createReviewArtifact, writeReviewArtifact } from "../../src/review/review-artifact.ts";
import { HarnessError } from "../../src/shared/errors.ts";
import { BudgetLedger } from "../../src/telemetry/budget.ts";
import { createScriptedClient } from "../helpers/scripted-judgment.ts";
import { samplePlan } from "./sample-plan.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-planning-run-"));
  roots.push(root);
  const changeRoot = resolve(root, "openspec", "changes", "add-search");
  await mkdir(changeRoot, { recursive: true });
  const status = { changeName: "add-search", changeRoot } as unknown as OpenSpecStatus;
  const calls: string[] = [];
  let exists = true;
  const adapter = {
    status: async () => {
      calls.push("status");
      if (!exists) throw new HarnessError("OPENSPEC_COMMAND_FAILED", "change not found");
      return status;
    },
    createChange: async (_name: string, _description: string, schema?: string) => {
      calls.push(`create:${schema}`);
      exists = true;
      return {};
    },
  } as unknown as OpenSpecAdapter;
  const modelStack = synthesizeLegacyStack({
    architectModel: "openai/architect",
    builderModel: "openai/builder",
    architectThinking: "high",
    builderThinking: "high",
  });
  return { root, changeRoot, adapter, calls, modelStack, missing: () => { exists = false; } };
}

const CANDIDATE: Candidate = { path: "src/toolbar.ts", matchedTerms: ["toolbar"], excerpt: "1: export function Toolbar() {" };
const planText = (plan: unknown = samplePlan()) => JSON.stringify(plan);
const invalidPlan = () => {
  const plan = samplePlan();
  plan.tasks[0] = { ...plan.tasks[0]!, verify: ["cargo test"] };
  return plan;
};

interface SessionCall { kind: PlanningSessionKind; input: PlanningPromptInput }

async function plan(
  subject: Awaited<ReturnType<typeof fixture>>,
  answers: (call: SessionCall, index: number) => string,
  options: Partial<ProductionPlanningOptions> = {},
) {
  const sessions: SessionCall[] = [];
  let outcome: Awaited<ReturnType<typeof runProductionPlanning>> | undefined;
  let error: unknown;
  try {
    outcome = await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "propose",
      prompt: "Add a search box to the toolbar",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      judgment: createInertJudgmentRuntime(),
      retrieve: async () => [CANDIDATE],
      ensureSchema: async () => { subject.calls.push("ensure-schema"); },
      session: async (kind, input) => {
        sessions.push({ kind, input });
        return answers({ kind, input }, sessions.length - 1);
      },
      ...options,
    });
  } catch (caught) {
    error = caught;
  }
  const written = async () => (await readdir(subject.changeRoot, { recursive: true }).catch(() => [])).sort();
  return { outcome, error, sessions, kinds: sessions.map(({ kind }) => kind), written };
}

describe("planning orchestration", () => {
  test("a clean plan writes all four artifacts from one plan session, with no preflight session", async () => {
    const subject = await fixture();
    const result = await plan(subject, () => planText());
    expect(result.kinds).toEqual(["plan"]);
    expect(result.outcome).toMatchObject({
      status: "success",
      next: "/change review add-search",
      summary: "propose completed on the medium lane; OpenSpec artifacts were written.",
    });
    expect(await result.written()).toEqual(["design.md", "proposal.md", "specs", "specs/toolbar-search", "specs/toolbar-search/spec.md", "tasks.md"]);
    expect(await readFile(resolve(subject.changeRoot, "tasks.md"), "utf8")).toContain("```yaml harness-task");
  });

  test("the lane is recorded before the first session starts", async () => {
    const subject = await fixture();
    let laneAtSession: Awaited<ReturnType<typeof readLane>> | undefined;
    await plan(subject, () => {
      return planText();
    }, {
      session: async () => {
        laneAtSession = await readLane(createChangeUsageStore(subject.root), "add-search");
        return planText();
      },
    });
    expect(laneAtSession).toMatchObject({ lane: "medium", source: "pattern" });
    expect(laneAtSession!.decidedAt).not.toBe("");
  });

  test("a large lane runs opinions and a debate first, and the plan session receives their analysis", async () => {
    const subject = await fixture();
    const result = await plan(subject, () => planText(), { lane: "large" });
    expect(result.kinds).toEqual(["opinion", "opinion", "debate", "plan"]);
    const planning = result.sessions.at(-1)!.input;
    expect(planning.lane).toBe("large");
    expect(planning.priorAnalysis?.map(({ content }) => content)).toHaveLength(3);
  });

  test("small and medium lanes run no optional stages", async () => {
    for (const lane of ["small", "medium"] as const) {
      const subject = await fixture();
      const result = await plan(subject, () => planText(), { lane });
      expect(result.kinds).toEqual(["plan"]);
      expect(result.sessions[0]!.input.lane).toBe(lane);
    }
  });

  test("a clarification blocks with the question and writes nothing, and no change is created", async () => {
    const subject = await fixture();
    subject.missing();
    const result = await plan(subject, () => planText({
      disposition: "needs_clarification",
      summary: "Ambiguous.",
      question: "Which toolbar do you mean?",
      evidence: [{ path: "src/toolbar.ts", reason: "There are two." }],
    }));
    expect(result.outcome).toMatchObject({ status: "blocked", next: "Which toolbar do you mean?", blocker: { kind: "lifecycle" } });
    expect(result.outcome?.summary).toContain("- src/toolbar.ts: There are two.");
    expect(subject.calls.some((call) => call.startsWith("create"))).toBeFalse();
    expect(await result.written()).toEqual([]);
  });

  test("an already-satisfied report blocks with the standard question when the session gave none", async () => {
    const subject = await fixture();
    const result = await plan(subject, () => planText({ disposition: "already_satisfied", summary: "It exists.", evidence: [] }));
    expect(result.outcome).toMatchObject({
      status: "blocked",
      next: "Which branch, deployment, or entry point still exhibits the behavior you want changed?",
    });
    expect(await result.written()).toEqual([]);
  });

  test("a validation failure gets one retry that names the failures, then succeeds", async () => {
    const subject = await fixture();
    const result = await plan(subject, (_call, index) => index === 0 ? planText(invalidPlan()) : planText());
    expect(result.kinds).toEqual(["plan", "plan"]);
    expect(result.sessions[0]!.input.validationFailures).toBeUndefined();
    expect(result.sessions[1]!.input.validationFailures).toContain("tasks[0].verify[0]");
    expect(result.sessions[1]!.input.validationFailures).toContain('Executable "cargo" is not allowed');
    expect(result.outcome?.status).toBe("success");
    expect(await result.written()).toContain("proposal.md");
  });

  test("an answer that is not JSON is retried the same way", async () => {
    const subject = await fixture();
    const result = await plan(subject, (_call, index) => index === 0 ? "I could not produce a plan." : planText());
    expect(result.sessions[1]!.input.validationFailures).toContain("expected exactly one JSON object, found 0");
    expect(result.outcome?.status).toBe("success");
  });

  test("a second failure ends the command with the list, and nothing is written", async () => {
    const subject = await fixture();
    const result = await plan(subject, () => planText(invalidPlan()));
    expect(result.kinds).toEqual(["plan", "plan"]);
    expect(result.error).toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    expect((result.error as Error).message).toContain("tasks[0].verify[0]");
    expect(await result.written()).toEqual([]);
  });

  test("propose creates the OpenSpec change after the plan is accepted, then writes into it", async () => {
    const subject = await fixture();
    subject.missing();
    const result = await plan(subject, () => planText());
    expect(subject.calls).toEqual(["status", "ensure-schema", "create:fusion-driven", "status"]);
    expect(result.outcome?.status).toBe("success");
  });

  test("refine gives the session the current artifacts and a revising review's required changes", async () => {
    const subject = await fixture();
    await writeFile(resolve(subject.changeRoot, "proposal.md"), "# Proposal\n\nOld.\n");
    await mkdir(resolve(subject.changeRoot, "specs", "search"), { recursive: true });
    await writeFile(resolve(subject.changeRoot, "specs", "search", "spec.md"), "## ADDED Requirements\n");
    await writeReviewArtifact(resolve(subject.changeRoot, "review.md"), createReviewArtifact({
      schemaVersion: 1,
      round: 1,
      reviewedAt: "2026-09-18T12:00:00.000Z",
      model: "openai/reviewer",
      artifactDigest: "a".repeat(64),
      requestedVerdict: "REVISE",
      criticalFindings: [],
      requiredChanges: ["Handle the empty-query case explicitly."],
      recommendations: [],
    }));
    const result = await plan(subject, () => planText(), { phase: "refine", prompt: "" });
    const input = result.sessions[0]!.input;
    expect(input.requiredChanges).toContain("Handle the empty-query case explicitly.");
    expect(input.currentArtifacts?.map(({ path }) => path)).toEqual(["proposal.md", "specs/search/spec.md"]);
    expect(result.outcome).toMatchObject({ status: "success", action: "refine" });
  });

  test("a mandatory synthesis that the budget cannot afford stops before any session", async () => {
    const subject = await fixture();
    const result = await plan(subject, () => planText(), { budget: new BudgetLedger({ phases: { planning: { totalTokens: 1 } } }) });
    expect(result.error).toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(result.sessions).toEqual([]);
  });
});

describe("planning with triage", () => {
  const noul = (value: number) => ({ type: "noul" as const, noul: value });
  const answers = (choice: string, confidence: number, candidate: readonly [number, number] = [0.1, 0.9]): JudgmentAnswers => ({
    disposition: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence },
    candidate_1_implements: noul(candidate[0]),
    candidate_1_needs_change: noul(candidate[1]),
    public_contract: noul(0.05),
    data_migration: noul(0.05),
    security_boundary: noul(0.05),
    design_ambiguity: noul(0.05),
    mechanical: noul(0.9),
    reach: { type: "score", score: 0.2, probabilities: { "0": 0.9 }, confidence: 0.9 },
  });
  const judgment = (subject: Awaited<ReturnType<typeof fixture>>, mode: "enforce" | "shadow", client: ReturnType<typeof createScriptedClient>) =>
    createJudgmentRuntime({
      env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: mode },
      store: createChangeUsageStore(subject.root),
      client,
    });

  test("a confident proceed puts the change on the small lane and tells the session to return a plan", async () => {
    const subject = await fixture();
    const client = createScriptedClient({ "change.triage": answers("proceed", 0.95) });
    const result = await plan(subject, () => planText(), { judgment: judgment(subject, "enforce", client) });
    expect(client.requests).toHaveLength(1);
    expect(result.sessions[0]!.input).toMatchObject({ lane: "small", triageProceeds: true });
    expect(result.outcome?.summary).toContain("on the small lane");
    const [record] = await listDecisionRecords(createChangeUsageStore(subject.root), "add-search");
    expect(record).toMatchObject({ decision: "change.triage", acted: true, observed: { producedBy: "judgment", lane: "small", laneHeld: true } });
  });

  test("a corroborated already-satisfied blocks with the standard question and runs no session", async () => {
    const subject = await fixture();
    const client = createScriptedClient({ "change.triage": answers("already_satisfied", 0.95, [0.9, 0.1]) });
    const result = await plan(subject, () => planText(), { judgment: judgment(subject, "enforce", client) });
    expect(result.sessions).toEqual([]);
    expect(result.outcome).toMatchObject({
      status: "blocked",
      next: "Which branch, deployment, or entry point still exhibits the behavior you want changed?",
    });
    expect(result.outcome?.summary).toContain("- src/toolbar.ts:");
  });

  test("an uncertain disposition leaves the session to decide, without the triage note", async () => {
    const subject = await fixture();
    const client = createScriptedClient({ "change.triage": answers("proceed", 0.5) });
    const result = await plan(subject, () => planText(), { judgment: judgment(subject, "enforce", client) });
    expect(result.sessions[0]!.input.triageProceeds).toBeFalse();
  });

  test("shadow mode records the session's disposition beside the judged one and uses the pattern lane", async () => {
    const subject = await fixture();
    const client = createScriptedClient({ "change.triage": answers("proceed", 0.95) });
    const result = await plan(subject, () => planText(), { judgment: judgment(subject, "shadow", client) });
    expect(result.sessions[0]!.input).toMatchObject({ lane: "medium", triageProceeds: false });
    const [record] = await listDecisionRecords(createChangeUsageStore(subject.root), "add-search");
    expect(record).toMatchObject({
      mode: "shadow",
      acted: false,
      agreement: true,
      observed: { producedBy: "agent", agentDisposition: "proceed", shadowLane: "small" },
    });
  });
});

describe("planning is a library", () => {
  test("the phase file contains no schema, validation, rendering or prompt code", async () => {
    const phase = await readFile(resolve(import.meta.dir, "../../src/change/phases/planning.ts"), "utf8");
    for (const forbidden of ["z.object", "planSchema", "validatePlan", "renderArtifacts", "renderPrompt", "JSON.stringify", "embeddedJson"]) {
      expect(phase, forbidden).not.toContain(forbidden);
    }
    expect(phase.split("\n").length).toBeLessThan(110);
  });

  test("no planning module is larger than about 250 lines", async () => {
    const directory = resolve(import.meta.dir, "../../src/planning");
    for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".ts"))) {
      const lines = (await readFile(resolve(directory, name), "utf8")).split("\n").length;
      expect(lines, name).toBeLessThanOrEqual(250);
    }
  });
});

describe("planning merges chained tasks", () => {
  test("the outcome lists each merge, and the written task list has the merged task", async () => {
    const subject = await fixture();
    const chained = samplePlan();
    chained.tasks = [
      { ...chained.tasks[0]!, writes: ["src/toolbar.ts"] },
      { ...chained.tasks[1]!, dependsOn: ["1.1"], writes: ["src/toolbar.ts"] },
    ];
    const result = await plan(subject, () => planText(chained));
    expect(result.outcome?.summary).toContain("Tasks merged:\n- merged 1.2 into 1.1: same write scope");
    const tasks = await readFile(resolve(subject.changeRoot, "tasks.md"), "utf8");
    expect(tasks).toContain("Add the filter to the toolbar view Then: Document the search box");
    expect(tasks).not.toContain("- [ ] 1.2");
  });

  test("a plan with nothing to merge has no merge section", async () => {
    const subject = await fixture();
    const result = await plan(subject, () => planText());
    expect(result.outcome?.summary).not.toContain("Tasks merged");
  });

  test("the planner is told to prefer cohesive tasks", async () => {
    const { renderPlanPrompt } = await import("../../src/planning/prompts.ts");
    expect(renderPlanPrompt({ changeName: "x", request: "y", lane: "medium", authoritativeContext: {} })).toContain("Prefer one task per cohesive set of files.");
  });
});
