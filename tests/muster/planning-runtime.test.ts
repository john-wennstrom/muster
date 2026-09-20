import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import {
  parsePreflight,
  preflightPrompt,
  runProductionPlanning,
  thinkingForPlanning,
  type PlanningPreflight,
  type PlanningPreflightRequest,
} from "../../src/change/phases/planning.ts";
import { STANDARD_ALREADY_SATISFIED_QUESTION } from "../../src/controller/preflight-composition.ts";
import type { Candidate } from "../../src/context/candidates.ts";
import type { JudgmentAnswers, JudgmentClientRequest } from "../../src/judgment/client.ts";
import { runProcess } from "../../src/shared/process.ts";
import type { CommandOutcome } from "../../src/change/command.ts";
import { FUSION_DRIVEN_SCHEMA_NAME } from "../../src/openspec/fusion-driven-schema.ts";
import { createReviewArtifact, writeReviewArtifact } from "../../src/review/review-artifact.ts";
import { HarnessError } from "../../src/shared/errors.ts";
import { classifyChange, type ComplexityDecision } from "../../src/controller/complexity-router.ts";
import { patternRiskInputs } from "../../src/controller/complexity-inputs.ts";
import { createInertJudgmentRuntime, createJudgmentRuntime, type JudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type { JudgmentClient, JudgmentUnavailableReason } from "../../src/judgment/client.ts";
import { createDeadClient, createReplayClient } from "../../src/judgment/replay.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { BudgetLedger } from "../../src/telemetry/budget.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecStatus } from "../../src/openspec/protocol.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(planningArtifacts: string[] = ["proposal", "specs", "design", "tasks"]) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-planning-runtime-"));
  roots.push(root);
  const changeRoot = resolve(root, "openspec", "changes", "add-search");
  await mkdir(changeRoot, { recursive: true });
  const status: OpenSpecStatus = {
    changeName: "add-search",
    schemaName: "spec-driven",
    planningHome: { kind: "repo", root, changesDir: resolve(root, "openspec", "changes"), defaultSchema: "spec-driven" },
    changeRoot,
    artifactPaths: {},
    isPlanningComplete: false,
    isComplete: false,
    applyRequires: ["tasks"],
    nextSteps: [],
    actionContext: {
      mode: "repo-local",
      sourceOfTruth: "repo",
      planningArtifacts,
      linkedContext: [],
      allowedEditRoots: [root],
      requiresAffectedAreaSelection: false,
      constraints: [],
    },
    artifacts: [],
    root: { path: root, source: "nearest" },
  };
  const instructionCalls: string[] = [];
  const adapter = {
    status: async () => status,
    instructions: async (artifact: string) => {
      instructionCalls.push(artifact);
      return {
        changeName: "add-search",
        artifactId: artifact,
        schemaName: "spec-driven",
        changeDir: changeRoot,
        planningHome: status.planningHome,
        outputPath: `${artifact}.md`,
        resolvedOutputPath: resolve(changeRoot, `${artifact}.md`),
        existingOutputPaths: [],
        description: `${artifact} artifact`,
        instruction: `Write ${artifact}`,
        template: `# ${artifact}`,
        dependencies: [],
        unlocks: [],
        root: status.root,
      };
    },
  } as unknown as OpenSpecAdapter;
  const modelStack = synthesizeLegacyStack({
    architectModel: "openai/architect",
    builderModel: "openai/builder",
    architectThinking: "high",
    builderThinking: "high",
  });
  return { root, changeRoot, adapter, instructionCalls, modelStack };
}

const proceed = {
  disposition: "proceed" as const,
  summary: "The requested behavior needs a change.",
  evidence: [{ path: "src/search/view.ts", reason: "Current behavior differs." }],
};

describe("production planning runtime", () => {
  test("accepts one strict preflight object with harmless prose or a Markdown fence", () => {
    const json = JSON.stringify({
      disposition: "already_satisfied",
      summary: "The behavior already exists.",
      evidence: [{ path: "src/view.ts", reason: "It navigates to the full page." }],
      question: "Which deployment still fails?",
    });
    expect(parsePreflight(json).disposition).toBe("already_satisfied");
    expect(parsePreflight(`Confirmed by the route.\n\n${json}`).disposition).toBe("already_satisfied");
    expect(parsePreflight(`\`\`\`json\n${json}\n\`\`\``).disposition).toBe("already_satisfied");
    expect(() => parsePreflight(`${json}\n${json}`)).toThrow("exactly one JSON object");
  });

  test("tolerates an empty question string on a non-clarification disposition", () => {
    const json = JSON.stringify({
      disposition: "proceed",
      summary: "The change is still needed.",
      evidence: [{ path: "src/view.ts", reason: "Behavior differs from the request." }],
      question: "",
    });
    const preflight = parsePreflight(json);
    expect(preflight.disposition).toBe("proceed");
    expect(preflight.question).toBeUndefined();
  });

  test("still requires a real question when disposition is needs_clarification", () => {
    const json = JSON.stringify({
      disposition: "needs_clarification",
      summary: "Ambiguous target.",
      evidence: [],
      question: "",
    });
    let error: unknown;
    try {
      parsePreflight(json);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).details.issues).toMatchObject([
      { message: "Clarification disposition requires a question" },
    ]);
  });

  test("uses cheaper thinking for direct and bounded planning", () => {
    expect(thinkingForPlanning("direct", "high")).toBe("low");
    expect(thinkingForPlanning("bounded", "high")).toBe("medium");
    expect(thinkingForPlanning("architectural", "high")).toBe("high");
  });

  test("runs the planning controller and writes only validated OpenSpec artifacts", async () => {
    const subject = await fixture();
    const stages: string[] = [];
    const outcome = await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "refine",
      prompt: "Add bounded search",
      runId: "planning-run",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      runPreflight: async () => proceed,
      runAgent: async (request, _status, slot) => {
        stages.push(`${request.stage}:${slot.model}`);
        return {
          model: slot.model,
          content: JSON.stringify({ artifacts: [
            { path: "proposal.md", content: "# Proposal" },
            { path: "design.md", content: "# Design" },
            { path: "specs/search/spec.md", content: "## Purpose\nSearch behavior contract.\n\n## ADDED Requirements" },
            { path: "tasks.md", content: "## 1. Search\n" },
          ] }),
        };
      },
    });

    expect(stages).toEqual(["synthesis:openai/architect"]);
    expect(subject.instructionCalls).toEqual(["proposal", "specs", "design", "tasks"]);
    expect(outcome).toMatchObject({ status: "success", action: "refine", runId: "planning-run" });
    expect(await readFile(resolve(subject.changeRoot, "proposal.md"), "utf8")).toBe("# Proposal\n");
    expect(await readFile(resolve(subject.changeRoot, "specs", "search", "spec.md"), "utf8")).toContain("Search behavior");
  });

  test("folds a pending REVISE review's required changes into refine's prompt automatically", async () => {
    const subject = await fixture();
    const review = createReviewArtifact({
      schemaVersion: 1,
      round: 1,
      reviewedAt: "2026-09-18T12:00:00.000Z",
      model: "openai/reviewer",
      artifactDigest: "a".repeat(64),
      requestedVerdict: "REVISE",
      criticalFindings: [],
      requiredChanges: ["Handle the empty-query case explicitly."],
      recommendations: [],
    });
    await writeReviewArtifact(resolve(subject.changeRoot, "review.md"), review);

    const preflightPrompts: string[] = [];
    const outcome = await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "refine",
      prompt: "",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      runPreflight: async (request) => {
        preflightPrompts.push(request.prompt);
        return proceed;
      },
      runAgent: async (_request, _status, slot) => ({
        model: slot.model,
        content: JSON.stringify({ artifacts: [
          { path: "proposal.md", content: "# Proposal" },
          { path: "design.md", content: "# Design" },
          { path: "specs/search/spec.md", content: "## Purpose\nSearch behavior contract.\n\n## ADDED Requirements" },
          { path: "tasks.md", content: "## 1. Search\n" },
        ] }),
      }),
    });

    expect(preflightPrompts).toHaveLength(1);
    expect(preflightPrompts[0]).toContain("Handle the empty-query case explicitly.");
    expect(outcome.status).toBe("success");
  });

  test("excludes review/verification instructions a fusion-driven schema also tracks as planning artifacts", async () => {
    const subject = await fixture(["proposal", "specs", "design", "tasks", "review", "verification"]);
    const outcome = await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "refine",
      prompt: "Add bounded search",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      runPreflight: async () => proceed,
      runAgent: async (_request, _status, slot) => ({
        model: slot.model,
        content: JSON.stringify({ artifacts: [
          { path: "proposal.md", content: "# Proposal" },
          { path: "design.md", content: "# Design" },
          { path: "specs/search/spec.md", content: "## Purpose\nSearch behavior contract.\n\n## ADDED Requirements" },
          { path: "tasks.md", content: "## 1. Search\n" },
        ] }),
      }),
    });

    expect(subject.instructionCalls).toEqual(["proposal", "specs", "design", "tasks"]);
    expect(outcome.status).toBe("success");
  });

  test("rejects an incomplete synthesis before writing any artifact", async () => {
    const subject = await fixture();
    let error: unknown;
    try {
      await runProductionPlanning({
        cwd: subject.root,
        changeName: "add-search",
        phase: "refine",
        prompt: "Incomplete",
        openSpec: subject.adapter,
        modelStack: subject.modelStack,
        runPreflight: async () => proceed,
        runAgent: async (_request, _status, slot) => ({
          model: slot.model,
          content: JSON.stringify({ artifacts: [
            { path: "proposal.md", content: "# Proposal" },
            { path: "design.md", content: "# Design" },
            { path: "tasks.md", content: "## Tasks" },
          ] }),
        }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    expect(readFile(resolve(subject.changeRoot, "proposal.md"), "utf8")).rejects.toThrow();
  });

  test("asks one question without creating artifacts when preflight needs clarification", async () => {
    const subject = await fixture();
    const outcome = await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "propose",
      prompt: "Change the profile",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      runPreflight: async () => ({
        disposition: "needs_clarification",
        summary: "Two profile entry points have different behavior.",
        evidence: [{ path: "src/profiles/routes.ts", reason: "Both routes are plausible." }],
        question: "Which profile entry point should change?",
      }),
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      next: "Which profile entry point should change?",
      blocker: { kind: "lifecycle" },
    });
    expect(subject.instructionCalls).toEqual([]);
  });

  test("stops instead of inventing work when the request is already satisfied", async () => {
    const subject = await fixture();
    const outcome = await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "propose",
      prompt: "Navigate to the full page",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      runPreflight: async () => ({
        disposition: "already_satisfied",
        summary: "Both click paths already navigate to the full page.",
        evidence: [{ path: "src/profiles/view.ts", reason: "The route uses router.push." }],
      }),
    });

    expect(outcome.status).toBe("blocked");
    expect(outcome.next).toContain("branch, deployment, or entry point");
    expect(subject.instructionCalls).toEqual([]);
  });

  test("blocks preflight before agent work when the planning budget is exhausted", async () => {
    const subject = await fixture();
    await expect(runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "propose",
      prompt: "Add search",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      budget: new BudgetLedger({ phases: { planning: { totalTokens: 1 } } }),
      runPreflight: async () => proceed,
    })).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(subject.instructionCalls).toEqual([]);
  });

  test("creates the OpenSpec change and loads its artifact instructions before synthesis", async () => {
    const subject = await fixture();
    const calls: string[] = [];
    let statusCalls = 0;
    let createChangeSchema: string | undefined;
    const adapter = {
      status: async () => {
        calls.push("status");
        statusCalls += 1;
        if (statusCalls === 1) {
          throw new HarnessError("OPENSPEC_COMMAND_FAILED", "change not found");
        }
        return await subject.adapter.status("add-search");
      },
      createChange: async (_change: string, _description: string, schema?: string) => {
        calls.push("new-change");
        createChangeSchema = schema;
        return {};
      },
      instructions: async (artifact: string, change: string) => {
        calls.push(`instructions:${artifact}`);
        return await subject.adapter.instructions(artifact, change);
      },
    } as unknown as OpenSpecAdapter;

    await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "propose",
      prompt: "Add bounded search",
      openSpec: adapter,
      modelStack: subject.modelStack,
      ensureSchema: async () => {
        calls.push("ensure-schema");
      },
      runPreflight: async () => {
        calls.push("preflight");
        return proceed;
      },
      runAgent: async () => {
        calls.push("synthesis");
        return { model: "openai/architect", content: JSON.stringify({ artifacts: [
          { path: "proposal.md", content: "# Proposal" },
          { path: "design.md", content: "# Design" },
          { path: "specs/search/spec.md", content: "## ADDED Requirements" },
          { path: "tasks.md", content: "## Tasks" },
        ] }) };
      },
    });

    expect(calls).toEqual([
      "preflight",
      "status",
      "ensure-schema",
      "new-change",
      "status",
      "instructions:proposal",
      "instructions:specs",
      "instructions:design",
      "instructions:tasks",
      "synthesis",
    ]);
    expect(createChangeSchema).toBe(FUSION_DRIVEN_SCHEMA_NAME);
  });
});

describe("planning complexity judgment", () => {
  const AVOIDED_MIGRATION = "don't migrate the data, just add a column";
  const WIRE_FORMAT = "change the wire format between the broker and the child";
  const env = (mode: "shadow" | "enforce") => ({ MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "sk-test", MUSTER_JEV_MODE: mode });

  /** These tests are about complexity; preflight is judged as if disabled so it adds no calls or records. */
  function runtimeFor(
    root: string,
    mode: "shadow" | "enforce",
    client: JudgmentClient,
    budget?: BudgetLedger,
  ): JudgmentRuntime {
    const runtime = createJudgmentRuntime({ env: env(mode), store: createChangeUsageStore(root), client, budget });
    return {
      ...runtime,
      judge: ((decision, request) => decision.id === "planning.preflight"
        ? Promise.resolve({ kind: "fallback", reason: "disabled", recordId: null })
        : runtime.judge(decision, request)) as JudgmentRuntime["judge"],
    };
  }

  async function classify(
    subject: Awaited<ReturnType<typeof fixture>>,
    prompt: string,
    options: {
      judgment?: JudgmentRuntime;
      phase?: "propose" | "refine";
      evidence?: typeof proceed.evidence;
    } = {},
  ): Promise<{ complexity: ComplexityDecision }> {
    let complexity: ComplexityDecision | undefined;
    await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: options.phase ?? "propose",
      prompt,
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      judgment: options.judgment,
      runPreflight: async () => ({ ...proceed, evidence: options.evidence ?? proceed.evidence }),
      runAgent: async (request) => {
        complexity = request.complexity;
        return { model: "openai/architect", content: JSON.stringify({ artifacts: [
          { path: "proposal.md", content: "# Proposal" },
          { path: "design.md", content: "# Design" },
          { path: "specs/search/spec.md", content: "## ADDED Requirements" },
          { path: "tasks.md", content: "## Tasks" },
        ] }) };
      },
    });
    return { complexity: complexity! };
  }

  /** The classification the phase produces from the pattern inputs alone. */
  function patternOnly(prompt: string, phase: "propose" | "refine" = "propose"): ComplexityDecision {
    return classifyChange({
      affectedFiles: ["src/search/view.ts"],
      affectedCapabilities: ["search"],
      ...patternRiskInputs(prompt, phase),
    });
  }

  test("enforce corrects a pattern false positive", async () => {
    const subject = await fixture();
    const judgment = runtimeFor(subject.root, "enforce", createReplayClient());
    expect(patternOnly(AVOIDED_MIGRATION).classification).toBe("architectural");
    const { complexity } = await classify(subject, AVOIDED_MIGRATION, { judgment });
    expect(complexity.classification).toBe("direct");
    expect(complexity.signals).toContainEqual({ name: "data_migration", value: false, severity: "low" });
  });

  test("enforce corrects a pattern false negative", async () => {
    const subject = await fixture();
    const judgment = runtimeFor(subject.root, "enforce", createReplayClient());
    expect(patternOnly(WIRE_FORMAT).classification).toBe("direct");
    const { complexity } = await classify(subject, WIRE_FORMAT, { judgment });
    expect(complexity.classification).toBe("bounded");
    expect(complexity.signals).toContainEqual({ name: "public_contract", value: true, severity: "medium" });
  });

  test("shadow mode classifies exactly as the patterns do, and records the disagreement", async () => {
    const subject = await fixture();
    const judgment = runtimeFor(subject.root, "shadow", createReplayClient());
    for (const prompt of [AVOIDED_MIGRATION, WIRE_FORMAT]) {
      const { complexity } = await classify(subject, prompt, { judgment });
      expect(complexity).toEqual(patternOnly(prompt));
    }
    const records = await listDecisionRecords(createChangeUsageStore(subject.root), "add-search");
    expect(records).toHaveLength(2);
    const [migration] = records.filter((record) => record.observed.hasDataMigration === true);
    expect(migration).toMatchObject({
      mode: "shadow",
      acted: false,
      wouldHaveActed: true,
      agreement: false,
      observed: { hasDataMigration: true, hasPublicContractChange: false, planningPhase: "propose" },
    });
    expect(records.filter((record) => record.agreement === false)).toHaveLength(2);
  });

  test("a record shows the four inputs that were applied", async () => {
    const subject = await fixture();
    const judgment = runtimeFor(subject.root, "enforce", createReplayClient());
    await classify(subject, AVOIDED_MIGRATION, { judgment });
    const [record] = await listDecisionRecords(createChangeUsageStore(subject.root), "add-search");
    expect(record).toMatchObject({
      mode: "enforce",
      acted: true,
      observed: { applied: { hasDataMigration: false, hasPublicContractChange: false } },
    });
  });

  const clientReasons: JudgmentUnavailableReason[] = [
    "timeout", "rate_limit", "network", "server", "invalid_response", "model_mismatch", "aborted",
  ];
  for (const reason of clientReasons) {
    test(`unavailable judgment (${reason}) classifies exactly as the patterns do`, async () => {
      const subject = await fixture();
      const judgment = runtimeFor(subject.root, "enforce", createDeadClient(reason));
      for (const prompt of [AVOIDED_MIGRATION, WIRE_FORMAT]) {
        const { complexity } = await classify(subject, prompt, { judgment });
        expect(complexity).toEqual(patternOnly(prompt));
      }
      const records = await listDecisionRecords(createChangeUsageStore(subject.root), "add-search");
      expect(records.map((record) => record.unavailableReason)).toEqual([reason, reason]);
    });
  }

  test("an exhausted judgment budget classifies exactly as the patterns do", async () => {
    const subject = await fixture();
    const judgment = runtimeFor(
      subject.root,
      "enforce",
      createReplayClient(),
      new BudgetLedger({ phases: { planning: { totalTokens: 1 } } }),
    );
    const { complexity } = await classify(subject, AVOIDED_MIGRATION, { judgment });
    expect(complexity).toEqual(patternOnly(AVOIDED_MIGRATION));
    const [record] = await listDecisionRecords(createChangeUsageStore(subject.root), "add-search");
    expect(record).toMatchObject({ unavailableReason: "budget" });
  });

  test("a denied evidence path sends nothing and classifies as the patterns do", async () => {
    const subject = await fixture();
    let sent = 0;
    const judgment = runtimeFor(subject.root, "enforce", {
      async request() {
        sent += 1;
        throw new Error("must not be called");
      },
    });
    const { complexity } = await classify(subject, AVOIDED_MIGRATION, {
      judgment,
      evidence: [{ path: ".env", reason: "Configures the search service." }],
    });
    expect(sent).toBe(0);
    expect(complexity.classification).toBe("architectural");
  });

  test("an uncertain answer takes its pattern value while a confident one is applied", async () => {
    const subject = await fixture();
    // Migration is answered confidently no; public contract and security stay uncertain.
    const judgment = runtimeFor(subject.root, "enforce", {
      async request() {
        return {
          available: true,
          answers: {
            public_contract: { type: "noul", noul: 0.5 },
            data_migration: { type: "noul", noul: 0.05 },
            security_boundary: { type: "noul", noul: 0.5 },
            design_ambiguity: { type: "noul", noul: 0.5 },
            mechanical: { type: "noul", noul: 0.5 },
            reach: { type: "score", score: 1, probabilities: { "0": 1 }, confidence: 0.5 },
          },
          model: "jev-1.13.0",
          inputTokens: 100,
          outputTokens: 0,
          durationMs: 0,
        };
      },
    });
    const prompt = "Change the API permission model but don't migrate anything";
    const { complexity } = await classify(subject, prompt, { judgment });
    expect(complexity.signals).toEqual(expect.arrayContaining([
      { name: "public_contract", value: true, severity: "medium" },
      { name: "data_migration", value: false, severity: "low" },
      { name: "security_boundary", value: true, severity: "high" },
    ]));
    expect(complexity.classification).toBe("architectural");
  });

  test("a judged design ambiguity is ignored in a proposal but recorded", async () => {
    const subject = await fixture();
    const judgment = runtimeFor(subject.root, "enforce", {
      async request() {
        return {
          available: true,
          answers: {
            public_contract: { type: "noul", noul: 0.5 },
            data_migration: { type: "noul", noul: 0.5 },
            security_boundary: { type: "noul", noul: 0.5 },
            design_ambiguity: { type: "noul", noul: 0.95 },
            mechanical: { type: "noul", noul: 0.5 },
            reach: { type: "score", score: 1, probabilities: { "0": 1 }, confidence: 0.5 },
          },
          model: "jev-1.13.0",
          inputTokens: 100,
          outputTokens: 0,
          durationMs: 0,
        };
      },
    });
    const proposal = await classify(subject, "Add bounded search", { judgment });
    expect(proposal.complexity.classification).toBe("direct");
    const [record] = await listDecisionRecords(createChangeUsageStore(subject.root), "add-search");
    expect(record).toMatchObject({
      gate: { act: true, value: { hasDesignAmbiguity: true } },
      observed: { applied: { hasDesignAmbiguity: false } },
    });

    const refinement = await classify(subject, "Add bounded search", { judgment, phase: "refine" });
    expect(refinement.complexity.classification).toBe("architectural");
  });

  test("a disabled runtime sends no request and writes no record", async () => {
    const subject = await fixture();
    let sent = 0;
    const judgment = createJudgmentRuntime({
      env: {},
      store: createChangeUsageStore(subject.root),
      client: { async request() { sent += 1; throw new Error("must not be called"); } },
    });
    expect(judgment.enabled).toBe(false);
    const { complexity } = await classify(subject, AVOIDED_MIGRATION, { judgment });
    expect(complexity).toEqual(patternOnly(AVOIDED_MIGRATION));
    expect(sent).toBe(0);
    expect(await listDecisionRecords(createChangeUsageStore(subject.root), "add-search")).toEqual([]);
  });

  test("without an injected runtime and with judgment unset in the environment, nothing is judged", async () => {
    const saved = process.env.MUSTER_JEV;
    delete process.env.MUSTER_JEV;
    try {
      const { complexity } = await classify(await fixture(), WIRE_FORMAT);
      expect(complexity).toEqual(patternOnly(WIRE_FORMAT));
    } finally {
      if (saved !== undefined) process.env.MUSTER_JEV = saved;
    }
  });
});

describe("planning preflight judgment", () => {
  const REQUEST = "Make `openSearchPage` navigate to the full page";
  const env = (mode: "shadow" | "enforce") => ({ MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "sk-test", MUSTER_JEV_MODE: mode });
  const noul = (value: number) => ({ type: "noul" as const, noul: value });
  const uncertainComplexity: JudgmentAnswers = {
    public_contract: noul(0.5),
    data_migration: noul(0.5),
    security_boundary: noul(0.5),
    design_ambiguity: noul(0.5),
    mechanical: noul(0.5),
    reach: { type: "score", score: 1, probabilities: { "0": 1 }, confidence: 0.5 },
  };

  /** One candidate, src/search/view.ts: [implements, needsChange]. */
  function preflightAnswers(choice: string, confidence: number, candidate: readonly [number, number] = [0.1, 0.9]): JudgmentAnswers {
    return {
      disposition: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence },
      ambiguity: { type: "score", score: 0, probabilities: { "0": 1 }, confidence: 0.9 },
      candidate_1_implements: noul(candidate[0]),
      candidate_1_needs_change: noul(candidate[1]),
    };
  }

  function clientFor(answers: JudgmentAnswers, seen: JudgmentClientRequest[] = []): JudgmentClient {
    return {
      async request(request) {
        seen.push(request);
        return {
          available: true,
          answers: request.decision?.id === "planning.preflight" ? answers : uncertainComplexity,
          model: "jev-1.13.0",
          inputTokens: 100,
          outputTokens: 0,
          durationMs: 0,
        };
      },
    };
  }

  async function repository() {
    const subject = await fixture();
    const git = async (...args: string[]) => {
      const result = await runProcess("git", args, { cwd: subject.root, timeoutMs: 10_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    };
    await git("init");
    await git("config", "user.email", "muster@example.invalid");
    await git("config", "user.name", "Muster Tests");
    await mkdir(resolve(subject.root, "src/search"), { recursive: true });
    await writeFile(resolve(subject.root, "src/search/view.ts"), "export function openSearchPage() {\n  return \"/search\";\n}\n");
    await git("add", "src");
    await git("commit", "-m", "fixture");
    return subject;
  }

  const AGENT_PROCEED: PlanningPreflight = {
    disposition: "proceed",
    summary: "The agent says proceed.",
    evidence: [{ path: "src/search/view.ts", reason: "Agent-written reason." }],
  };

  async function run(
    subject: Awaited<ReturnType<typeof fixture>>,
    options: {
      judgment?: JudgmentRuntime;
      agentPreflight?: PlanningPreflight;
      retrieve?: (options: { cwd: string; request: string }) => Promise<Candidate[]>;
      budget?: BudgetLedger;
      budgetEstimates?: Parameters<typeof runProductionPlanning>[0]["budgetEstimates"];
      phase?: "propose" | "refine";
    } = {},
  ) {
    const preflightRequests: PlanningPreflightRequest[] = [];
    const agentContexts: unknown[] = [];
    let outcome: CommandOutcome | undefined;
    let error: unknown;
    try {
      outcome = await runProductionPlanning({
        cwd: subject.root,
        changeName: "add-search",
        phase: options.phase ?? "propose",
        prompt: REQUEST,
        openSpec: subject.adapter,
        modelStack: subject.modelStack,
        judgment: options.judgment,
        retrieve: options.retrieve as never,
        budget: options.budget,
        budgetEstimates: options.budgetEstimates,
        runPreflight: async (request) => {
          preflightRequests.push(request);
          return options.agentPreflight ?? AGENT_PROCEED;
        },
        runAgent: async (request) => {
          agentContexts.push(request.authoritativeContext);
          return { model: "openai/architect", content: JSON.stringify({ artifacts: [
            { path: "proposal.md", content: "# Proposal" },
            { path: "design.md", content: "# Design" },
            { path: "specs/search/spec.md", content: "## ADDED Requirements" },
            { path: "tasks.md", content: "## Tasks" },
          ] }) };
        },
      });
    } catch (caught) {
      error = caught;
    }
    return { outcome, error, preflightRequests, agentContexts };
  }

  const runtimeFor = (subject: Awaited<ReturnType<typeof fixture>>, mode: "shadow" | "enforce", client: JudgmentClient, budget?: BudgetLedger) =>
    createJudgmentRuntime({ env: env(mode), store: createChangeUsageStore(subject.root), client, budget });

  const preflightRecords = async (subject: Awaited<ReturnType<typeof fixture>>) =>
    (await listDecisionRecords(createChangeUsageStore(subject.root), "add-search"))
      .filter((record) => record.decision === "planning.preflight");

  test("a confident proceed composes the preflight and never runs the agent", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("proceed", 0.9)));
    const { outcome, preflightRequests, agentContexts } = await run(subject, { judgment });
    expect(preflightRequests).toEqual([]);
    expect(outcome?.status).toBe("success");
    expect(agentContexts[0]).toMatchObject({
      preflight: {
        disposition: "proceed",
        evidence: [{ path: "src/search/view.ts", reason: expect.stringContaining("openSearchPage") }],
      },
    });
    expect(await preflightRecords(subject)).toMatchObject([{
      mode: "enforce",
      acted: true,
      observed: { producedBy: "judgment" },
      avoided: { activity: "preflight", totalTokens: 15_000, costUsd: 0.08 },
    }]);
  });

  test("a corroborated already-satisfied blocks with the standard question and never runs the agent", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("already_satisfied", 0.9, [0.85, 0.1])));
    const { outcome, preflightRequests, agentContexts } = await run(subject, { judgment });
    expect(preflightRequests).toEqual([]);
    expect(agentContexts).toEqual([]);
    expect(outcome).toMatchObject({
      status: "blocked",
      action: "propose",
      next: STANDARD_ALREADY_SATISFIED_QUESTION,
      blocker: { kind: "lifecycle", message: STANDARD_ALREADY_SATISFIED_QUESTION },
    });
    expect(outcome?.summary).toContain("- src/search/view.ts:");
    await expect(readFile(resolve(subject.changeRoot, "proposal.md"), "utf8")).rejects.toThrow();
  });

  test("the blocked outcome equals the one the agent path returns for the same disposition and evidence", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("already_satisfied", 0.9, [0.85, 0.1])));
    const judged = await run(subject, { judgment });
    const agent = await run(subject, {
      agentPreflight: {
        disposition: "already_satisfied",
        summary: "Placeholder.",
        evidence: [],
      },
    });
    expect(judged.outcome).toMatchObject({ status: "blocked", next: agent.outcome?.next, blocker: agent.outcome?.blocker });
  });

  test("an uncorroborated already-satisfied runs the agent with the candidates", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("already_satisfied", 0.95, [0.4, 0.9])));
    const { preflightRequests, outcome } = await run(subject, { judgment });
    expect(preflightRequests).toHaveLength(1);
    expect(preflightRequests[0]!.candidates?.map(({ path }) => path)).toEqual(["src/search/view.ts"]);
    expect(outcome?.status).toBe("success");
    expect(await preflightRecords(subject)).toMatchObject([{ acted: false, wouldHaveActed: false, observed: { producedBy: "agent" } }]);
  });

  test("a confident needs-clarification still runs the agent, whose question is the outcome", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("needs_clarification", 0.95)));
    const { preflightRequests, outcome } = await run(subject, {
      judgment,
      agentPreflight: {
        disposition: "needs_clarification",
        summary: "Ambiguous.",
        evidence: [],
        question: "Which page do you mean?",
      },
    });
    expect(preflightRequests).toHaveLength(1);
    expect(preflightRequests[0]!.candidates).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "blocked", next: "Which page do you mean?" });
  });

  test("below the confidence floor the agent runs with the candidates", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("proceed", 0.79)));
    const { preflightRequests } = await run(subject, { judgment });
    expect(preflightRequests).toHaveLength(1);
    expect(preflightRequests[0]!.candidates).toHaveLength(1);
  });

  test("shadow mode runs the agent with today's request, records the comparison, and never acts", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "shadow", clientFor(preflightAnswers("proceed", 0.95, [0.1, 0.9])));
    const { preflightRequests, outcome } = await run(subject, { judgment });
    expect(preflightRequests).toEqual([{ changeName: "add-search", prompt: REQUEST }]);
    expect(Object.hasOwn(preflightRequests[0]!, "candidates")).toBe(false);
    expect(outcome?.status).toBe("success");
    expect(await preflightRecords(subject)).toMatchObject([{
      mode: "shadow",
      acted: false,
      wouldHaveActed: true,
      agreement: true,
      observed: {
        producedBy: "agent",
        agentDisposition: "proceed",
        agentEvidencePaths: ["src/search/view.ts"],
        judgedRelevantPaths: ["src/search/view.ts"],
        evidenceOverlap: 1,
      },
    }]);
  });

  test("shadow mode records a disagreement with the agent's disposition", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "shadow", clientFor(preflightAnswers("already_satisfied", 0.95, [0.9, 0.1])));
    await run(subject, { judgment });
    expect(await preflightRecords(subject)).toMatchObject([{
      wouldHaveActed: true,
      agreement: false,
      observed: { agentDisposition: "proceed" },
    }]);
  });

  const clientReasons: JudgmentUnavailableReason[] = [
    "timeout", "rate_limit", "network", "server", "invalid_response", "model_mismatch", "aborted",
  ];
  for (const reason of clientReasons) {
    test(`unavailable judgment (${reason}) runs today's preflight`, async () => {
      const subject = await repository();
      const judgment = runtimeFor(subject, "enforce", createDeadClient(reason));
      const { preflightRequests, outcome } = await run(subject, { judgment });
      expect(preflightRequests).toEqual([{ changeName: "add-search", prompt: REQUEST }]);
      expect(Object.hasOwn(preflightRequests[0]!, "candidates")).toBe(false);
      expect(outcome?.status).toBe("success");
      expect(await preflightRecords(subject)).toMatchObject([{ unavailableReason: reason, acted: false }]);
    });
  }

  test("an exhausted judgment budget runs today's preflight", async () => {
    const subject = await repository();
    const budget = new BudgetLedger({ phases: { planning: { totalTokens: 1 } } });
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("proceed", 0.95)), budget);
    // The tiny budget blocks the agent's own forecast too, which is today's behavior.
    const { error, preflightRequests } = await run(subject, { judgment, budget });
    expect(error).toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(preflightRequests).toEqual([]);
    expect(await preflightRecords(subject)).toMatchObject([{ unavailableReason: "budget" }]);
  });

  test("disabled judgment does no retrieval, sends nothing, and writes no record", async () => {
    const subject = await repository();
    let sent = 0;
    let retrieved = 0;
    const judgment = createJudgmentRuntime({
      env: {},
      store: createChangeUsageStore(subject.root),
      client: { async request() { sent += 1; throw new Error("must not be called"); } },
    });
    const { preflightRequests } = await run(subject, {
      judgment,
      retrieve: async () => { retrieved += 1; return []; },
    });
    expect(preflightRequests).toEqual([{ changeName: "add-search", prompt: REQUEST }]);
    expect({ sent, retrieved }).toEqual({ sent: 0, retrieved: 0 });
    expect(await listDecisionRecords(createChangeUsageStore(subject.root), "add-search")).toEqual([]);
  });

  test("a retrieval error falls back to the agent without a judgment call", async () => {
    const subject = await repository();
    let sent = 0;
    const judgment = runtimeFor(subject, "enforce", {
      async request(request) {
        if (request.decision?.id === "planning.preflight") sent += 1;
        throw new Error("unavailable");
      },
    });
    const { preflightRequests, outcome } = await run(subject, {
      judgment,
      retrieve: async () => { throw new Error("git is unavailable"); },
    });
    expect(preflightRequests).toEqual([{ changeName: "add-search", prompt: REQUEST }]);
    expect(outcome?.status).toBe("success");
    expect(sent).toBe(0);
    expect(await preflightRecords(subject)).toEqual([]);
  });

  test("a judgment error falls back to the agent", async () => {
    const subject = await repository();
    const real = runtimeFor(subject, "enforce", clientFor(preflightAnswers("proceed", 0.95)));
    const judgment: JudgmentRuntime = {
      ...real,
      judge: (async (decision, request) => {
        if (decision.id === "planning.preflight") throw new Error("judge blew up");
        return real.judge(decision, request);
      }) as JudgmentRuntime["judge"],
    };
    const { preflightRequests, outcome } = await run(subject, { judgment });
    expect(preflightRequests).toEqual([{ changeName: "add-search", prompt: REQUEST }]);
    expect(outcome?.status).toBe("success");
  });

  test("a request that retrieves nothing still gets a judgment, and the agent runs with today's prompt when it does not act", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "enforce", clientFor({
      disposition: { type: "choice", choice: "proceed", probabilities: { proceed: 0.5 }, confidence: 0.5 },
      ambiguity: { type: "score", score: 0, probabilities: { "0": 1 }, confidence: 0.9 },
    }));
    const { preflightRequests } = await run(subject, { judgment, retrieve: async () => [] });
    expect(preflightRequests).toEqual([{ changeName: "add-search", prompt: REQUEST }]);
  });

  test("the request and candidate excerpts are what is sent, with the candidate paths declared", async () => {
    const subject = await repository();
    const seen: JudgmentClientRequest[] = [];
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("proceed", 0.9), seen));
    await run(subject, { judgment });
    const sent = seen.find((request) => request.decision?.id === "planning.preflight")!;
    expect(sent.state).toEqual({
      request: REQUEST,
      candidates: [{
        index: 1,
        path: "src/search/view.ts",
        excerpt: "1: export function openSearchPage() {",
      }],
    });
  });

  test("a skipped agent is never forecast, and judgment spend stays on the planning budget", async () => {
    const subject = await repository();
    const budget = new BudgetLedger({ phases: { planning: { totalTokens: 1_000_000 } } });
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("proceed", 0.9)), budget);
    // An agent estimate over the whole budget would block the run if the agent were forecast.
    const { outcome, preflightRequests } = await run(subject, {
      judgment,
      budget,
      budgetEstimates: { preflight: { totalTokens: 5_000_000, costUsd: null } },
    });
    expect(outcome?.status).toBe("success");
    expect(preflightRequests).toEqual([]);
    const later = budget.forecast({
      phase: "planning",
      role: "architect",
      activity: "specialist_opinion",
      estimate: { totalTokens: 0, costUsd: 0 },
    });
    // Two judgment calls (preflight and complexity) at 100 input tokens each; no agent spend.
    expect(later.scopes.find(({ scope }) => scope.level === "phase")?.used.totalTokens).toBe(200);
  });

  test("an agent that does run is still forecast against the budget", async () => {
    const subject = await repository();
    const judgment = runtimeFor(subject, "enforce", clientFor(preflightAnswers("proceed", 0.5)));
    const { error, preflightRequests } = await run(subject, {
      judgment,
      budgetEstimates: { preflight: { totalTokens: 5_000_000, costUsd: null } },
    });
    expect(error).toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(preflightRequests).toEqual([]);
  });
});

describe("preflight agent prompt", () => {
  /** Today's prompt, spelled out so any drift in the fallback path fails a test. */
  const TODAY = [
    "Determine whether the requested change is needed in the checked-out repository.",
    "Change: add-search",
    "User request: Add bounded search",
    "Use at most 6 read/search calls. Follow the nearest controlling code path only.",
    "Stop as soon as file evidence distinguishes proceed, needs_clarification, or already_satisfied.",
    "If checked-out behavior already satisfies the request, do not invent adjacent improvements; return already_satisfied and ask which branch, deployment, or entry point still fails.",
    "If ambiguity prevents a bounded proposal, return needs_clarification with one specific question.",
    "Return exactly one JSON object: {\"disposition\":\"proceed|needs_clarification|already_satisfied\",\"summary\":\"...\",\"evidence\":[{\"path\":\"repo/relative/path\",\"reason\":\"...\"}],\"question\":\"...\"}. Omit the \"question\" field entirely unless disposition is \"needs_clarification\" — do not include it as an empty string.",
  ].join("\n\n");
  const request = { changeName: "add-search", prompt: "Add bounded search" };

  test("without candidates it is today's prompt byte for byte", () => {
    expect(preflightPrompt(request)).toBe(TODAY);
    expect(preflightPrompt({ ...request, candidates: [] })).toBe(TODAY);
  });

  test("with candidates it lists them before the output contract and changes nothing else", () => {
    const prompt = preflightPrompt({
      ...request,
      candidates: [{ path: "src/search/view.ts", matchedTerms: ["openSearchPage"], excerpt: "1: export function openSearchPage() {\n2: return 1;" }],
    });
    const sections = TODAY.split("\n\n");
    const last = sections.at(-1)!;
    expect(prompt.startsWith(sections.slice(0, -1).join("\n\n"))).toBe(true);
    expect(prompt.endsWith(`\n\n${last}`)).toBe(true);
    expect(prompt).toContain("- src/search/view.ts (matched: openSearchPage)\n    1: export function openSearchPage() {\n    2: return 1;");
    expect(prompt.indexOf("Candidate files")).toBeLessThan(prompt.indexOf("Return exactly one JSON object"));
  });
});

describe("planning task quality judgment", () => {
  const env = (mode: "shadow" | "enforce") => ({ MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "sk-test", MUSTER_JEV_MODE: mode });
  const noul = (value: number) => ({ type: "noul" as const, noul: value });

  function taskBlock(id: string, description: string, dependsOn: string[] = []): string {
    const yaml = [
      `id: "${id}"`,
      `dependsOn: ${JSON.stringify(dependsOn)}`,
      "role: builder",
      "reads: []",
      'writes: ["src/search/**"]',
      'requirements: ["Search is bounded"]',
      'scenarios: ["Results are capped"]',
      'verify: ["bun test"]',
      "manual: null",
    ].map((line) => `  ${line}`).join("\n");
    return `- [ ] ${id} ${description}\n\n  \`\`\`yaml harness-task\n${yaml}\n  \`\`\`\n`;
  }

  function bundleFor(count: number, description = "Cap the results"): string {
    const tasks = Array.from({ length: count }, (_, index) =>
      taskBlock(`1.${index + 1}`, `${description} ${index + 1}`, index === 0 ? [] : [`1.${index}`])).join("\n");
    return JSON.stringify({ artifacts: [
      { path: "proposal.md", content: "## Why\n\nSearch is unbounded." },
      { path: "design.md", content: "# Design" },
      { path: "specs/search/spec.md", content: "### Requirement: Search is bounded\nResults SHALL be capped.\n\n#### Scenario: Results are capped\n- **THEN** at most 20 results" },
      { path: "tasks.md", content: `## 1. Work\n\n${tasks}` },
    ] });
  }

  /** Answers every task quality question clean, except the ones overridden. */
  function taskQualityClient(overrides: (index: number) => object = () => ({})): {
    client: JudgmentClient;
    requests: JudgmentClientRequest[];
  } {
    const requests: JudgmentClientRequest[] = [];
    const client: JudgmentClient = {
      async request(request) {
        requests.push(request);
        const answers: Record<string, JudgmentAnswers[string]> = {};
        for (const [name, question] of Object.entries(request.questions)) {
          const match = /^task_(\d+)_/.exec(name);
          const good = name.endsWith("_dependencies") ? 0.05 : 0.95;
          answers[name] = question.type === "score"
            ? { type: "score", score: 1, probabilities: { "1": 0.9 }, confidence: 0.9 }
            : noul(good);
          Object.assign(answers, match ? overrides(Number(match[1])) : {});
        }
        return { available: true, answers, model: "jev-1.13.0", inputTokens: 500, outputTokens: 0, durationMs: 0 };
      },
    };
    return { client, requests };
  }

  /** Only task quality is judged, so complexity and preflight add no calls or records. */
  function runtimeFor(root: string, mode: "shadow" | "enforce", client: JudgmentClient, budget?: BudgetLedger): JudgmentRuntime {
    const runtime = createJudgmentRuntime({ env: env(mode), store: createChangeUsageStore(root), client, budget });
    return {
      ...runtime,
      judge: ((decision, request) => decision.id === "planning.task_quality"
        ? runtime.judge(decision, request)
        : Promise.resolve({ kind: "fallback", reason: "disabled", recordId: null })) as JudgmentRuntime["judge"],
    };
  }

  const ARTIFACTS = ["proposal.md", "design.md", "specs/search/spec.md", "tasks.md"];

  async function plan(subject: Awaited<ReturnType<typeof fixture>>, judgment: JudgmentRuntime, bundle = bundleFor(3)) {
    const outcome = await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "propose",
      prompt: "Add bounded search",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      judgment,
      runPreflight: async () => proceed,
      runAgent: async () => ({ model: "openai/architect", content: bundle }),
    });
    const files = Object.fromEntries(await Promise.all(ARTIFACTS.map(async (path) =>
      [path, await readFile(resolve(subject.changeRoot, path), "utf8")] as const)));
    return { outcome, files };
  }

  const baseline = async (bundle = bundleFor(3)) => {
    const subject = await fixture();
    return plan(subject, createInertJudgmentRuntime(), bundle);
  };

  const records = (subject: Awaited<ReturnType<typeof fixture>>) =>
    listDecisionRecords(createChangeUsageStore(subject.root), "add-search");

  test("one call covers every task, the requirements, and the scenarios", async () => {
    const subject = await fixture();
    const { client, requests } = taskQualityClient();
    await plan(subject, runtimeFor(subject.root, "enforce", client), bundleFor(12));
    expect(requests).toHaveLength(1);
    const state = requests[0]!.state as { tasks: unknown[]; requirements: { name: string; scenarios: { name: string }[] }[] };
    expect(state.tasks).toHaveLength(12);
    expect(state.requirements[0]).toMatchObject({ name: "Search is bounded", scenarios: [{ name: "Results are capped" }] });
    expect(Object.keys(requests[0]!.questions)).toHaveLength(12 * 5 + 1);
  });

  test("findings are listed in the outcome in enforce mode and written artifacts are unchanged", async () => {
    const without = await baseline();
    const subject = await fixture();
    const { client } = taskQualityClient((index) => index === 2 ? { task_2_verification: noul(0.05) } : {});
    const withFindings = await plan(subject, runtimeFor(subject.root, "enforce", client));
    expect(withFindings.files).toEqual(without.files);
    expect(withFindings.outcome.summary.startsWith(without.outcome.summary)).toBe(true);
    expect(withFindings.outcome.summary).toContain("Task quality: 1 advisory finding");
    expect(withFindings.outcome.summary).toContain(
      "- Task 1.2: its verification commands may pass even if the task were implemented incorrectly (probability 0.95).",
    );
    expect({ ...withFindings.outcome, summary: without.outcome.summary }).toEqual(without.outcome);
    await expect(readFile(resolve(subject.changeRoot, "review.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("lists at most eight findings, highest probability first, and states the total", async () => {
    const subject = await fixture();
    const { client } = taskQualityClient((index) => ({ [`task_${index}_scope`]: noul(0.28 - index * 0.02) }));
    const { outcome } = await plan(subject, runtimeFor(subject.root, "enforce", client), bundleFor(11));
    expect(outcome.summary).toContain("Task quality: 11 advisory findings");
    expect(outcome.summary.match(/^- Task /gm)).toHaveLength(8);
    expect(outcome.summary).toContain("- 3 more not listed");
    expect(outcome.summary.indexOf("Task 1.11")).toBeLessThan(outcome.summary.indexOf("Task 1.4"));
  });

  test("a clean assessment leaves the outcome exactly as it is without judgment", async () => {
    const without = await baseline();
    const subject = await fixture();
    const clean = await plan(subject, runtimeFor(subject.root, "enforce", taskQualityClient().client));
    expect(clean).toEqual(without);
  });

  test("shadow findings appear nowhere but the record", async () => {
    const without = await baseline();
    const subject = await fixture();
    const { client } = taskQualityClient((index) => index === 1 ? { task_1_scope: noul(0.05) } : {});
    const shadow = await plan(subject, runtimeFor(subject.root, "shadow", client));
    expect(shadow).toEqual(without);
    const [record] = await records(subject);
    expect(record).toMatchObject({
      decision: "planning.task_quality",
      mode: "shadow",
      acted: false,
      wouldHaveActed: true,
      gate: { act: true, value: { findings: [{ kind: "scope", index: 1, probability: 0.95 }] } },
      observed: { taskIds: ["1.1", "1.2", "1.3"] },
    });
    expect(String(record!.observed.definitionDigest)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  const reasons: JudgmentUnavailableReason[] = [
    "timeout", "rate_limit", "network", "server", "invalid_response", "model_mismatch", "aborted",
  ];
  for (const reason of reasons) {
    test(`unavailable judgment (${reason}) leaves artifacts and outcome unchanged`, async () => {
      const without = await baseline();
      const subject = await fixture();
      const result = await plan(subject, runtimeFor(subject.root, "enforce", createDeadClient(reason)));
      expect(result).toEqual(without);
      expect((await records(subject)).map((record) => record.unavailableReason)).toEqual([reason]);
    });
  }

  test("an exhausted budget leaves artifacts and outcome unchanged", async () => {
    const without = await baseline();
    const subject = await fixture();
    const { client, requests } = taskQualityClient();
    const budget = new BudgetLedger({ phases: { planning: { totalTokens: 1 } } });
    expect(await plan(subject, runtimeFor(subject.root, "enforce", client, budget))).toEqual(without);
    expect(requests).toHaveLength(0);
    expect((await records(subject)).map((record) => record.unavailableReason)).toEqual(["budget"]);
  });

  test("a state too large to send leaves artifacts and outcome unchanged", async () => {
    const heavy = bundleFor(40, "x".repeat(3_000));
    const without = await baseline(heavy);
    const subject = await fixture();
    const { client, requests } = taskQualityClient();
    expect(await plan(subject, runtimeFor(subject.root, "enforce", client), heavy)).toEqual(without);
    expect(requests).toHaveLength(0);
    expect((await records(subject)).map((record) => record.unavailableReason)).toEqual(["state_too_large"]);
  });

  test("disabled judgment sends nothing, writes no record, and leaves planning as it is", async () => {
    const without = await baseline();
    const subject = await fixture();
    const { client, requests } = taskQualityClient();
    const disabled = createJudgmentRuntime({ env: {}, store: createChangeUsageStore(subject.root), client });
    expect(await plan(subject, disabled)).toEqual(without);
    expect(requests).toHaveLength(0);
    expect(await records(subject)).toEqual([]);
  });

  test("a task list that does not validate, or is empty, is not assessed", async () => {
    const invalid = JSON.parse(bundleFor(2)) as { artifacts: { path: string; content: string }[] };
    invalid.artifacts.find(({ path }) => path === "tasks.md")!.content = "## 1. Work\n\n- [ ] 1.1 No metadata\n";
    for (const bundle of [JSON.stringify(invalid), bundleFor(0), bundleFor(41)]) {
      const without = await baseline(bundle);
      const subject = await fixture();
      const { client, requests } = taskQualityClient();
      expect(await plan(subject, runtimeFor(subject.root, "enforce", client), bundle)).toEqual(without);
      expect(requests).toHaveLength(0);
      expect(await records(subject)).toEqual([]);
    }
  });

  test("a failure inside the assessment never fails planning", async () => {
    const without = await baseline();
    const subject = await fixture();
    const runtime = runtimeFor(subject.root, "enforce", taskQualityClient().client);
    const failing: JudgmentRuntime = {
      ...runtime,
      judge: ((decision, request) => decision.id === "planning.task_quality"
        ? Promise.reject(new Error("boom"))
        : runtime.judge(decision, request)) as JudgmentRuntime["judge"],
    };
    expect(await plan(subject, failing)).toEqual(without);
  });
});
