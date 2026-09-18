import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import { parsePreflight, runProductionPlanning, thinkingForPlanning } from "../../src/change/phases/planning.ts";
import { HarnessError } from "../../src/shared/errors.ts";
import { BudgetLedger } from "../../src/telemetry/budget.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecStatus } from "../../src/openspec/protocol.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
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
      planningArtifacts: ["proposal", "specs", "design", "tasks"],
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
    const adapter = {
      status: async () => {
        calls.push("status");
        statusCalls += 1;
        if (statusCalls === 1) {
          throw new HarnessError("OPENSPEC_COMMAND_FAILED", "change not found");
        }
        return await subject.adapter.status("add-search");
      },
      createChange: async () => {
        calls.push("new-change");
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
      "new-change",
      "status",
      "instructions:proposal",
      "instructions:specs",
      "instructions:design",
      "instructions:tasks",
      "synthesis",
    ]);
  });
});
