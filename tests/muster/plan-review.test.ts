import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import { runProductionReview } from "../../src/change/phases/review.ts";
import { createChangeSnapshot } from "../../src/controller/change-snapshot.ts";
import { escalateLane, readLane, writeLane, type Lane } from "../../src/controller/lane.ts";
import { createInertJudgmentRuntime, createJudgmentRuntime, type JudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { planLintQuestionId, PLAN_LINT_COVERAGE_QUESTION_ID } from "../../src/judgment/questions.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import type { PlanTask } from "../../src/planning/plan-schema.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../../src/review/artifact-digest.ts";
import { parseReviewArtifact } from "../../src/review/review-artifact.ts";
import { openSpecFor, writeValidPlan } from "../helpers/plan-fixture.ts";
import { createDeadClient, createScriptedClient } from "../helpers/scripted-judgment.ts";
import { samplePlan } from "../planning/sample-plan.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const size = (score: number, confidence: number) => ({
  type: "score" as const, score, probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 }, confidence,
});
/** Every concern clean for `count` tasks, with overrides. */
function lintAnswers(count: number, overrides: JudgmentAnswers = {}): JudgmentAnswers {
  const answers: Record<string, JudgmentAnswers[string]> = { [PLAN_LINT_COVERAGE_QUESTION_ID]: noul(0.95) };
  for (let index = 1; index <= count; index += 1) {
    answers[planLintQuestionId(index, "verification")] = noul(0.95);
    answers[planLintQuestionId(index, "scope")] = noul(0.95);
    answers[planLintQuestionId(index, "atomicity")] = noul(0.95);
    answers[planLintQuestionId(index, "dependencies")] = noul(0.05);
    answers[planLintQuestionId(index, "size")] = size(0.5, 0.9);
  }
  return { ...answers, ...overrides };
}

const manualTask = (): PlanTask => ({
  ...samplePlan().tasks[1]!,
  role: "manual",
  manual: { category: "authentication", reason: "Sign in", instructions: ["Sign in yourself"], expectedOutcome: "Signed in", resumeTarget: "1.2" },
});

async function setup(options: {
  lane?: Lane;
  plan?: ReturnType<typeof samplePlan>;
  judgment?: (store: ReturnType<typeof createChangeUsageStore>) => JudgmentRuntime;
  breakPlan?: (changeRoot: string) => Promise<void>;
} = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-plan-review-"));
  roots.push(root);
  const changeRoot = resolve(root, "openspec", "changes", "add-search");
  await mkdir(changeRoot, { recursive: true });
  await writeValidPlan(changeRoot, options.plan);
  await options.breakPlan?.(changeRoot);
  const store = createChangeUsageStore(root);
  if (options.lane) await writeLane(store, "add-search", { lane: options.lane, source: "judgment", reasons: ["test"] });
  const judgment = options.judgment?.(store) ?? createInertJudgmentRuntime();
  const prompts: string[] = [];
  const run = () => runProductionReview({
    cwd: root,
    changeName: "add-search",
    runId: "review-run",
    openSpec: openSpecFor(changeRoot),
    modelStack: synthesizeLegacyStack({ architectModel: "openai/architect", builderModel: "openai/reviewer", architectThinking: "high", builderThinking: "high" }),
    judgment,
    now: () => new Date("2026-09-20T10:00:00.000Z"),
    runner: async (request) => {
      prompts.push(request.prompt);
      return { review: { verdict: "APPROVE", criticalFindings: [], requiredChanges: [], recommendations: [] }, toolNames: ["muster_read"] };
    },
  });
  const persisted = async () => parseReviewArtifact(await readFile(resolve(changeRoot, "review.md"), "utf8"), resolve(changeRoot, "review.md"));
  return { root, changeRoot, store, run, prompts, persisted };
}

const enforcing = (client: ReturnType<typeof createScriptedClient> | ReturnType<typeof createDeadClient>) =>
  (store: ReturnType<typeof createChangeUsageStore>) =>
    createJudgmentRuntime({ env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce" }, store, client: client as never });

describe("lint runs before any reviewer", () => {
  test("a lint failure blocks with the whole list, and no reviewer and no judgment request", async () => {
    const client = createScriptedClient({ "plan.lint": lintAnswers(2) });
    const context = await setup({
      lane: "small",
      judgment: enforcing(client),
      breakPlan: async (changeRoot) => {
        const tasks = resolve(changeRoot, "tasks.md");
        await writeFile(tasks, (await readFile(tasks, "utf8")).replace('"Typing filters the list"]', '"Typing filters the list", "No such scenario"]').replace("bun test tests/toolbar.test.ts", "cargo test"));
      },
    });
    const outcome = await context.run();
    expect(outcome).toMatchObject({ status: "blocked", action: "review", next: "/change refine add-search" });
    expect(outcome.summary).toContain("Plan lint failed with 2 problem(s)");
    expect(outcome.summary).toContain('scenario "No such scenario" is not under a requirement the task cites');
    expect(outcome.summary).toContain('verification command "cargo test"');
    expect(context.prompts).toEqual([]);
    expect(client.requests).toEqual([]);
    await expect(context.persisted()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the small lane", () => {
  test("a clean plan is approved by lint after a clean semantic check, and no reviewer runs", async () => {
    const client = createScriptedClient({ "plan.lint": lintAnswers(2) });
    const context = await setup({ lane: "small", judgment: enforcing(client) });
    const outcome = await context.run();
    expect(outcome).toMatchObject({ status: "success", next: "/change implement add-search" });
    expect(outcome.summary).toContain("approved by lint");
    expect(context.prompts).toEqual([]);
    expect(client.requests).toHaveLength(1);
    const review = await context.persisted();
    expect(review).toMatchObject({ mode: "lint", model: "lint", verdict: "APPROVE", lint: { semanticCheck: "ran" } });
    expect(review.lint!.checks.length).toBeGreaterThan(5);
    expect((await readLane(context.store, "add-search")).lane).toBe("small");
  });

  test("a confident finding escalates to medium and the reviewer runs with the finding as a note", async () => {
    const client = createScriptedClient({ "plan.lint": lintAnswers(2, { [planLintQuestionId(2, "size")]: size(2.9, 0.95) }) });
    const context = await setup({ lane: "small", judgment: enforcing(client) });
    const outcome = await context.run();
    expect(outcome.summary).toContain("escalated from the small lane to medium: the semantic check reported 1 finding(s)");
    expect(context.prompts).toHaveLength(1);
    expect(context.prompts[0]).toContain("Unverified automated notes about the task list");
    expect(context.prompts[0]).toContain("Task 1.2: it may be too large to verify as one unit");
    expect(await context.persisted()).toMatchObject({ mode: "reviewer", model: "openai/reviewer" });
    const lane = await readLane(context.store, "add-search");
    expect(lane.lane).toBe("medium");
    expect(lane.escalations).toMatchObject([{ from: "small", to: "medium", reason: "the semantic check reported 1 finding(s)" }]);
  });

  test("an uncertain concern escalates to medium", async () => {
    const client = createScriptedClient({ "plan.lint": lintAnswers(2, { [planLintQuestionId(1, "scope")]: noul(0.5) }) });
    const context = await setup({ lane: "small", judgment: enforcing(client) });
    await context.run();
    expect((await readLane(context.store, "add-search")).escalations[0]!.reason).toBe("the semantic check left 1 concern(s) uncertain");
    expect(context.prompts).toHaveLength(1);
    expect(context.prompts[0]).not.toContain("Unverified automated notes");
  });

  test("unavailable judgment does not escalate: the plan is approved by lint and review.md says the semantic check did not run", async () => {
    const context = await setup({ lane: "small", judgment: enforcing(createDeadClient("network")) });
    const outcome = await context.run();
    expect(outcome.status).toBe("success");
    expect(context.prompts).toEqual([]);
    expect(await context.persisted()).toMatchObject({ mode: "lint", lint: { semanticCheck: "unavailable" } });
    expect((await readLane(context.store, "add-search")).escalations).toEqual([]);
  });

  test("with judgment disabled the plan is approved by lint alone", async () => {
    const context = await setup({ lane: "small" });
    expect((await context.run()).status).toBe("success");
    expect(await context.persisted()).toMatchObject({ mode: "lint", lint: { semanticCheck: "unavailable" } });
  });

  test("in shadow mode the answer is recorded and not used", async () => {
    const client = createScriptedClient({ "plan.lint": lintAnswers(2, { [planLintQuestionId(2, "size")]: size(2.9, 0.95) }) });
    const context = await setup({
      lane: "small",
      judgment: (store) => createJudgmentRuntime({ env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "shadow" }, store, client }),
    });
    await context.run();
    expect(context.prompts).toEqual([]);
    expect(await context.persisted()).toMatchObject({ mode: "lint", lint: { semanticCheck: "unavailable", answers: ["the semantic check ran in shadow mode and was not used"] } });
    expect(await listDecisionRecords(context.store, "add-search")).toMatchObject([{ decision: "plan.lint", mode: "shadow", acted: false }]);
  });

  test("too many tasks for small escalates instead of failing, and the reviewer runs", async () => {
    const plan = samplePlan();
    plan.tasks.push({ ...plan.tasks[1]!, id: "1.3", dependsOn: ["1.2"], writes: ["docs/three.md"] });
    const context = await setup({ lane: "small", plan });
    const outcome = await context.run();
    expect(outcome.summary).toContain("the plan has 3 tasks and the small lane allows 2");
    expect(context.prompts).toHaveLength(1);
    expect((await readLane(context.store, "add-search")).lane).toBe("medium");
  });

  test("a manual task on the small lane escalates", async () => {
    const plan = samplePlan();
    plan.tasks[1] = manualTask();
    const context = await setup({ lane: "small", plan });
    const outcome = await context.run();
    expect(outcome.summary).toContain("manual task(s) 1.2");
    expect(context.prompts).toHaveLength(1);
  });

  test("more than 40 tasks send no semantic request and follow the medium path", async () => {
    const plan = samplePlan();
    plan.tasks = Array.from({ length: 41 }, (_, index) => ({
      ...plan.tasks[0]!, id: `1.${index + 1}`, dependsOn: [], writes: [`src/file-${index + 1}.ts`],
    }));
    const client = createScriptedClient({ "plan.lint": lintAnswers(41) });
    const context = await setup({ lane: "small", plan, judgment: enforcing(client) });
    await context.run();
    expect(client.requests).toEqual([]);
    expect(context.prompts).toHaveLength(1);
    expect((await readLane(context.store, "add-search")).lane).toBe("medium");
  });

  test("escalating after a lint approval requires review again, and that review dispatches the reviewer", async () => {
    const context = await setup({ lane: "small" });
    await context.run();
    expect(context.prompts).toEqual([]);
    const digest = await hashReviewedArtifacts(await discoverReviewedArtifacts(context.root, context.changeRoot));
    const snapshot = async () => {
      const lane = await readLane(context.store, "add-search");
      return createChangeSnapshot({
        capturedAt: "2026-09-20T10:00:00.000Z",
        openSpec: { observedAt: "2026-09-20T10:00:00.000Z", changeName: "add-search", planningComplete: true, tasks: { "1.1": false }, artifactDigest: digest },
        repository: { observedAt: "2026-09-20T10:00:00.000Z", repositoryId: "r", commonDirectory: "/r/.git", worktree: "/r", head: "a".repeat(40), indexDigest: "i", diffDigest: "d", sourceDigest: "s" },
        runtime: null,
        review: { observedAt: "2026-09-20T10:00:00.000Z", artifact: await context.persisted() },
        validation: null,
        pendingCheckpointIds: [],
        lane: { lane: lane.lane, source: lane.source, escalations: lane.escalations.length },
      });
    };
    expect((await snapshot()).freshness.review).toBe("current");
    await escalateLane(context.store, "add-search", "medium", "a write fell outside the declared scopes");
    expect((await snapshot()).lifecycle).toBe("REVIEW_REQUIRED");

    await context.run();
    expect(context.prompts).toHaveLength(1);
    expect(await context.persisted()).toMatchObject({ mode: "reviewer", round: 2 });
  });
});

describe("the medium and large lanes", () => {
  for (const lane of ["medium", "large"] as const) {
    test(`${lane}: the reviewer runs after lint, and findings are unverified notes that change no verdict`, async () => {
      const client = createScriptedClient({ "plan.lint": lintAnswers(2, { [PLAN_LINT_COVERAGE_QUESTION_ID]: noul(0.05) }) });
      const context = await setup({ lane, judgment: enforcing(client) });
      const outcome = await context.run();
      expect(context.prompts).toHaveLength(1);
      expect(context.prompts[0]).toContain("- The tasks together may not cover every requirement (probability 0.95).");
      expect(outcome).toMatchObject({ status: "success", next: "/change implement add-search" });
      expect(await context.persisted()).toMatchObject({ mode: "reviewer", verdict: "APPROVE", criticalFindings: [], requiredChanges: [] });
      expect((await readLane(context.store, "add-search")).escalations).toEqual([]);
    });
  }

  test("without judgment the reviewer prompt has no notes, exactly as before", async () => {
    const context = await setup({ lane: "medium" });
    await context.run();
    expect(context.prompts[0]).not.toContain("Unverified");
  });
});
