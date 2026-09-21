/**
 * Session budgets: with the agent child process replaced by a counter, how many model sessions a
 * change costs from proposal to a passing verification.
 *
 * The figures below are the simplification series' promise: a small change starts at most three
 * sessions and a medium one at most four. They are edited only in a change that needs more, and
 * that change states why in its own description. The counts are sessions, not tokens; what a
 * session costs is measured by the manual acceptance run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import { runProductionImplementation } from "../../src/change/phases/implementation.ts";
import { runProductionPlanning } from "../../src/change/phases/planning.ts";
import { runProductionReview } from "../../src/change/phases/review.ts";
import { runBuilderStep } from "../../src/change/phases/task-steps/builder.ts";
import type { TaskStepContext } from "../../src/change/phases/task-steps/context.ts";
import { runReviewStep } from "../../src/change/phases/task-steps/review.ts";
import { runProductionVerification } from "../../src/change/phases/verification.ts";
import type { Lane } from "../../src/controller/lane.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import type { JudgmentAnswers, JudgmentClient } from "../../src/judgment/client.ts";
import {
  PLAN_LINT_COVERAGE_QUESTION_ID,
  TASK_FOCUS_QUESTION_IDS as FOCUS,
  TASK_ROUTING_QUESTION_IDS as ROUTING,
  TASK_ROUTING_RISK_QUESTION_IDS,
  planLintQuestionId,
} from "../../src/judgment/questions.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecApplyInstructions, OpenSpecStatus } from "../../src/openspec/protocol.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { runPlanningSession } from "../../src/planning/session.ts";
import { runBrokeredPlanningReviewer } from "../../src/review/planning-reviewer.ts";
import { HarnessError } from "../../src/shared/errors.ts";
import { runProcess } from "../../src/shared/process.ts";
import { createDeadClient, createScriptedClient } from "../helpers/scripted-judgment.ts";
import { createSessionCounter } from "../helpers/session-count.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const CHANGE = "add-search";
const noul = (value: number) => ({ type: "noul" as const, noul: value });
const score = (value: number, confidence = 0.9) => ({ type: "score" as const, score: value, probabilities: { "0": 1 - confidence }, confidence });

const smallTriage: JudgmentAnswers = {
  disposition: { type: "choice", choice: "proceed", probabilities: { proceed: 0.95 }, confidence: 0.95 },
  candidate_1_implements: noul(0.1),
  candidate_1_needs_change: noul(0.9),
  public_contract: noul(0.05),
  data_migration: noul(0.05),
  security_boundary: noul(0.05),
  design_ambiguity: noul(0.05),
  mechanical: noul(0.9),
  reach: score(0.2),
};
const cleanLint: JudgmentAnswers = {
  [PLAN_LINT_COVERAGE_QUESTION_ID]: noul(0.95),
  [planLintQuestionId(1, "verification")]: noul(0.95),
  [planLintQuestionId(1, "scope")]: noul(0.95),
  [planLintQuestionId(1, "atomicity")]: noul(0.95),
  [planLintQuestionId(1, "dependencies")]: noul(0.05),
  [planLintQuestionId(1, "size")]: { type: "score", score: 0.5, probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 }, confidence: 0.9 },
};
const routable: JudgmentAnswers = {
  [ROUTING.mechanical]: noul(0.9),
  ...Object.fromEntries(TASK_ROUTING_RISK_QUESTION_IDS.map((id) => [id, noul(0.1)])),
  [ROUTING.reach]: score(0.4),
};
const goodFocus: JudgmentAnswers = {
  [FOCUS.scopeContainment]: noul(0.95), [FOCUS.contractMatch]: noul(0.95), [FOCUS.scenarioCoverage]: noul(0.95),
  [FOCUS.testFirstConsistency]: noul(0.95), [FOCUS.stubOrHardcoded]: noul(0.05), [FOCUS.securityBoundary]: noul(0.05),
  [FOCUS.reach]: score(0.2),
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

/** A repository with one source file, and an OpenSpec stand-in that reads the change as the phases write it. */
async function project() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-session-budget-"));
  roots.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "muster@example.invalid");
  await git(root, "config", "user.name", "Muster Tests");
  await mkdir(resolve(root, "src"), { recursive: true });
  await writeFile(resolve(root, "src", "toolbar.ts"), "export const toolbar = 1;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");

  const changeRoot = resolve(root, "openspec", "changes", CHANGE);
  const tasksPath = resolve(changeRoot, "tasks.md");
  let created = false;
  const planningHome = { kind: "repo", root, changesDir: resolve(root, "openspec", "changes"), defaultSchema: "fusion-driven" } as const;
  const status = (): OpenSpecStatus => ({
    changeName: CHANGE,
    schemaName: "fusion-driven",
    planningHome,
    changeRoot,
    artifactPaths: { tasks: { outputPath: "tasks.md", resolvedOutputPath: tasksPath, existingOutputPaths: [tasksPath] } },
    isPlanningComplete: true,
    isComplete: true,
    applyRequires: ["review"],
    nextSteps: [],
    actionContext: { mode: "repo-local", sourceOfTruth: "repo", planningArtifacts: [], linkedContext: [], allowedEditRoots: [root], requiresAffectedAreaSelection: false, constraints: [] },
    artifacts: [{ id: "tasks", outputPath: "tasks.md", status: "done", requires: [] }],
    root: { path: root, source: "nearest" },
  });
  const apply = async (): Promise<OpenSpecApplyInstructions> => {
    const entries = [...(await readFile(tasksPath, "utf8")).matchAll(/^- \[( |x)\] (.+)$/gm)]
      .map((match, index) => ({ id: String(index + 1), description: match[2]!, done: match[1] === "x" }));
    const complete = entries.filter((entry) => entry.done).length;
    return {
      changeName: CHANGE,
      changeDir: changeRoot,
      schemaName: "fusion-driven",
      contextFiles: { tasks: [tasksPath] },
      progress: { total: entries.length, complete, remaining: entries.length - complete },
      tasks: entries,
      state: complete === entries.length ? "all_done" : "ready",
      instruction: "Implement",
      root: { path: root, source: "nearest" },
    };
  };
  const adapter = {
    status: async () => {
      if (!created) throw new HarnessError("OPENSPEC_COMMAND_FAILED", "change not found");
      return status();
    },
    createChange: async () => {
      created = true;
      await mkdir(changeRoot, { recursive: true });
      return {};
    },
    applyInstructions: apply,
    validate: async () => ({
      items: [{ id: CHANGE, type: "change", valid: true, issues: [] }],
      summary: { totals: { items: 1, passed: 1, failed: 0 }, byType: { change: { items: 1, passed: 1, failed: 0 } } },
      version: "fixture",
      root: { path: root, source: "nearest" },
    }),
  } as unknown as OpenSpecAdapter;
  return { root, adapter };
}

const stack = synthesizeLegacyStack({
  architectModel: "openai/architect",
  builderModel: "openai/builder",
  architectThinking: "high",
  builderThinking: "high",
});

/** Drives propose, review, implement and verify with only the child process replaced. */
async function lifecycle(options: { client: JudgmentClient; lane?: Lane }) {
  const subject = await project();
  const counter = createSessionCounter();
  const usage = createChangeUsageStore(subject.root);
  const judgment = createJudgmentRuntime({
    env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce" },
    store: usage,
    client: options.client,
  });
  const common = { cwd: subject.root, changeName: CHANGE, openSpec: subject.adapter, modelStack: stack, judgment };
  const identity = await new GitAdapter(subject.root).identity();
  const head = await new GitAdapter(subject.root).head();
  const step: TaskStepContext = {
    runId: `run-${CHANGE}`,
    changeName: CHANGE,
    planningCwd: subject.root,
    store: usage,
    stack,
    judgment,
    routing: new Map(),
  };

  const planning = await runProductionPlanning({
    ...common,
    phase: "propose",
    prompt: "Add a search box to the toolbar",
    lane: options.lane,
    retrieve: async () => [{ path: "src/toolbar.ts", matchedTerms: ["toolbar"], excerpt: "1: export const toolbar = 1;" }],
    ensureSchema: async () => undefined,
    session: (kind, input, sessionOptions) => runPlanningSession(kind, input, { ...sessionOptions, runChild: counter.child as never }),
  });
  const review = await runProductionReview({
    ...common,
    runner: (request) => runBrokeredPlanningReviewer(request, counter.child as never),
    now: () => new Date("2026-09-21T10:00:00.000Z"),
  });
  const implementation = await runProductionImplementation({
    ...common,
    reviewFreshness: "current",
    argv: [],
    now: () => new Date("2026-09-21T10:04:00.000Z"),
    ports: {
      selectWorktree: async () => ({
        repositoryId: identity.id,
        commonDirectory: identity.commonDirectory,
        path: identity.root,
        branch: "muster/add-search",
        head: head.commit,
        reused: true,
      }),
      runBuilder: (task, context, signal, attempt) => runBuilderStep(step, task, context, signal, counter.child as never, attempt),
      runVerification: async () => ({ passed: true, evidence: ["bun test tests/toolbar.test.ts: exit 0"] }),
      runReview: (task, builder, verification, context, signal) => runReviewStep(step, task, context, builder, verification, signal, counter.child as never),
    },
  });
  const verification = await runProductionVerification({
    ...common,
    argv: [],
    ports: { runCommand: async (command) => ({ command, exitCode: 0 }) },
    now: () => new Date("2026-09-21T10:05:00.000Z"),
  });
  return { counter, planning, review, implementation, verification };
}

describe("agent session budgets", () => {
  test("a small change stays within three sessions and starts no planning reviewer", async () => {
    const { counter, planning, review, implementation, verification } = await lifecycle({
      client: createScriptedClient({
        "change.triage": smallTriage,
        "plan.lint": cleanLint,
        "routing.task_model": routable,
        "review.task_focus": goodFocus,
      }),
    });

    expect(planning.summary).toContain("on the small lane");
    expect(review.summary).toContain("approved by lint");
    expect(implementation.status).toBe("success");
    expect(verification).toMatchObject({ status: "success", action: "verify" });
    expect(counter.count("planning-reviewer")).toBe(0);
    expect(counter.sessions.length).toBeLessThanOrEqual(3);
    // With every focus question good the review is skipped too, so the change costs two sessions.
    expect(counter.sessions).toEqual(["plan", "builder"]);
  });

  test("a medium change with judgment unavailable stays within four sessions", async () => {
    const { counter, review, implementation, verification } = await lifecycle({ client: createDeadClient("network") });

    expect(review.status).toBe("success");
    expect(implementation.status).toBe("success");
    expect(verification).toMatchObject({ status: "success", action: "verify" });
    expect(counter.sessions.length).toBeLessThanOrEqual(4);
    expect(counter.sessions).toEqual(["plan", "planning-reviewer", "builder", "task-reviewer"]);
  });

  test("a large change runs specialist opinions and a debate before the plan session", async () => {
    const counter = createSessionCounter();
    const subject = await project();
    await runProductionPlanning({
      cwd: subject.root,
      changeName: CHANGE,
      openSpec: subject.adapter,
      modelStack: stack,
      judgment: createJudgmentRuntime({ env: {}, store: createChangeUsageStore(subject.root) }),
      phase: "propose",
      prompt: "Add a search box to the toolbar",
      lane: "large",
      retrieve: async () => [],
      ensureSchema: async () => undefined,
      session: (kind, input, sessionOptions) => runPlanningSession(kind, input, { ...sessionOptions, runChild: counter.child as never }),
    });

    expect(counter.sessions).toEqual(["opinion", "opinion", "debate", "plan"]);
  });
});
