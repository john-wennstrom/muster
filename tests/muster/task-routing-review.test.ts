import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import type { AgentRun } from "../../src/agents/run-record.ts";
import { economyBuilderSlot, economyReviewerSlot } from "../../src/change/models.ts";
import { runBuilderStep } from "../../src/change/phases/task-steps/builder.ts";
import type { TaskStepContext } from "../../src/change/phases/task-steps/context.ts";
import { runReviewStep } from "../../src/change/phases/task-steps/review.ts";
import { writeLane, type Lane } from "../../src/controller/lane.ts";
import { readSourceDigest } from "../../src/execution/change-digests.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import type { ValidatedTask } from "../../src/execution/task-schema.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { TASK_FOCUS_QUESTION_IDS as FOCUS, TASK_ROUTING_QUESTION_IDS as IDS, TASK_ROUTING_RISK_QUESTION_IDS } from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { createTaskCodeReview } from "../../src/review/code-review.ts";
import { createScriptedClient } from "../helpers/scripted-judgment.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const scored = (score: number, confidence: number) => ({ type: "score" as const, score, probabilities: { "0": 1 - confidence }, confidence });
const routing = (reach: number): JudgmentAnswers => ({
  [IDS.mechanical]: noul(0.9),
  ...Object.fromEntries(TASK_ROUTING_RISK_QUESTION_IDS.map((id) => [id, noul(0.1)])),
  [IDS.reach]: scored(reach, 0.9),
});
const focus: JudgmentAnswers = {
  [FOCUS.scopeContainment]: noul(0.95), [FOCUS.contractMatch]: noul(0.5), [FOCUS.scenarioCoverage]: noul(0.95),
  [FOCUS.testFirstConsistency]: noul(0.95), [FOCUS.stubOrHardcoded]: noul(0.05), [FOCUS.securityBoundary]: noul(0.05),
  [FOCUS.reach]: scored(0.2, 0.9),
};

const stack = synthesizeLegacyStack({ architectModel: "p/architect", builderModel: "p/primary", architectThinking: "high", builderThinking: "high" });
const env = { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce" };
const task = {
  id: "1.1", role: "builder", dependsOn: [], description: "Rename the flag", requirements: ["cli: renamed"], scenarios: ["Renamed"],
  reads: ["src/**"], writes: ["src/**"], verify: ["bun test"],
} as unknown as ValidatedTask;

async function harness(options: { reach: number; lane?: Lane; economy?: Record<string, string>; env?: Record<string, string> }) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-routing-review-"));
  roots.push(root);
  const repo = resolve(root, "repo");
  await mkdir(resolve(repo, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await writeFile(resolve(repo, "src", "a.ts"), "1\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  await writeFile(resolve(repo, "src", "a.ts"), "2\n");
  const store = new AtomicJsonStore(resolve(root, "runs"));
  if (options.lane) await writeLane(store, "add-widget", { lane: options.lane, source: "user", reasons: ["fixture"] });
  const client = createScriptedClient({ "routing.task_model": routing(options.reach), "review.task_focus": focus });
  const step: TaskStepContext = {
    runId: "run-1", changeName: "add-widget", planningCwd: root, store, stack,
    judgment: createJudgmentRuntime({ env: options.env ?? env, store, client }),
    economyBuilder: economyBuilderSlot(stack, options.economy ?? {}),
    economyReviewer: economyReviewerSlot(stack, options.economy ?? {}),
    routing: new Map(),
  };
  const builderSeen: { model: string; thinking?: string }[] = [];
  const reviewerSeen: { model: string; thinking?: string }[] = [];
  const build = (attempt = 1) => runBuilderStep(step, task, { worktree: { path: repo }, writerLease: null } as never, undefined, (async (child: { run: AgentRun; thinking?: string }) => {
    builderSeen.push({ model: child.run.model, thinking: child.thinking });
    child.run.status = "done";
    child.run.text = JSON.stringify({ claim: "completed", implementationPersisted: true });
  }) as never, attempt);
  const review = async () => {
    const { sourceDigest } = await readSourceDigest(new GitAdapter(repo));
    return runReviewStep(step, task, { worktree: { path: repo }, writerLease: null } as never, { tddEvidence: { disposition: "required" } } as never, { passed: true, evidence: ["bun test: pass"] }, undefined, (async (child: { run: AgentRun; thinking?: string }) => {
      reviewerSeen.push({ model: child.run.model, thinking: child.thinking });
      child.run.exitCode = 0;
      child.run.text = JSON.stringify(createTaskCodeReview({ runId: "run-1", taskId: "1.1", reviewedAt: "2026-09-21T10:00:00.000Z", model: child.run.model, sourceDigest, findings: [] }));
      child.run.toolNames = ["muster_read"];
    }) as never);
  };
  const routingRequests = () => client.requests.filter((request) => request.decision?.id === "routing.task_model").length;
  return { step, build, review, builderSeen, reviewerSeen, routingRequests };
}

describe("thinking per task", () => {
  test("a mechanical narrow task gets builder low and reviewer medium", async () => {
    const subject = await harness({ reach: 0.2 });
    await subject.build();
    await subject.review();
    expect(subject.builderSeen[0]!.thinking).toBe("low");
    expect(subject.reviewerSeen[0]!.thinking).toBe("medium");
  });

  test("a mechanical task of moderate reach gets builder medium and reviewer high", async () => {
    const subject = await harness({ reach: 1.0 });
    await subject.build();
    await subject.review();
    expect(subject.builderSeen[0]!.thinking).toBe("medium");
    expect(subject.reviewerSeen[0]!.thinking).toBe("high");
  });

  test("a task routing does not act on keeps the configured thinking and a high reviewer", async () => {
    const subject = await harness({ reach: 2.5 });
    await subject.build();
    await subject.review();
    expect(subject.builderSeen[0]!.thinking).toBe("high");
    expect(subject.reviewerSeen[0]!.thinking).toBe("high");
  });

  test("exactly one routing request serves the builder and the reviewer", async () => {
    const subject = await harness({ reach: 0.2 });
    await subject.build();
    await subject.review();
    expect(subject.routingRequests()).toBe(1);
  });

  test("a retry keeps the configured thinking and the primary model, and the review defaults to high", async () => {
    const subject = await harness({ reach: 0.2, economy: { MUSTER_BUILDER_ECONOMY_MODEL: "p/cheap" } });
    await subject.build(1);
    await subject.build(2);
    await subject.review();
    expect(subject.builderSeen.map((seen) => [seen.model, seen.thinking])).toEqual([["p/cheap", "low"], ["p/primary", "high"]]);
    expect(subject.reviewerSeen[0]!.thinking).toBe("high");
    expect(subject.routingRequests()).toBe(1);
  });

  test("the large lane never lowers thinking and sends no routing request", async () => {
    const subject = await harness({ reach: 0.2, lane: "large" });
    await subject.build();
    await subject.review();
    expect(subject.builderSeen[0]!.thinking).toBe("high");
    expect(subject.reviewerSeen[0]!.thinking).toBe("high");
    expect(subject.routingRequests()).toBe(0);
  });

  test("shadow mode changes nothing", async () => {
    const subject = await harness({ reach: 0.2, env: { ...env, MUSTER_JEV_MODE: "shadow" } });
    await subject.build();
    await subject.review();
    expect(subject.builderSeen[0]!.thinking).toBe("high");
    expect(subject.reviewerSeen[0]!.thinking).toBe("high");
  });
});

describe("the economy models", () => {
  test("each override resolves independently", () => {
    expect(economyBuilderSlot(stack, { MUSTER_BUILDER_ECONOMY_MODEL: "p/b" })?.model).toBe("p/b");
    expect(economyReviewerSlot(stack, { MUSTER_BUILDER_ECONOMY_MODEL: "p/b" })).toBeNull();
    expect(economyReviewerSlot(stack, { MUSTER_REVIEWER_ECONOMY_MODEL: "p/r" })?.model).toBe("p/r");
    expect(economyBuilderSlot(stack, { MUSTER_REVIEWER_ECONOMY_MODEL: "p/r" })).toBeNull();
    expect(economyReviewerSlot(stack, { MUSTER_REVIEWER_ECONOMY_MODEL: "  " })).toBeNull();
  });

  test("the economy reviewer differs from the ordinary reviewer slot only in the model", () => {
    const economy = economyReviewerSlot(stack, { MUSTER_REVIEWER_ECONOMY_MODEL: "p/r" })!;
    const ordinary = stack.slots.find((slot) => slot.model !== stack.primaryBuilder.model) ?? stack.slots[0]!;
    expect({ ...economy, model: undefined }).toEqual({ ...ordinary, model: undefined });
  });

  test("an economy-eligible task is reviewed by the reviewer economy model when one is configured", async () => {
    const subject = await harness({ reach: 0.2, economy: { MUSTER_REVIEWER_ECONOMY_MODEL: "p/cheap-reviewer" } });
    await subject.build();
    await subject.review();
    expect(subject.reviewerSeen[0]!.model).toBe("p/cheap-reviewer");
    expect(subject.builderSeen[0]!.model).toBe("p/primary");
  });

  test("a task that is not economy-eligible is reviewed by the ordinary reviewer", async () => {
    const subject = await harness({ reach: 2.5, economy: { MUSTER_REVIEWER_ECONOMY_MODEL: "p/cheap-reviewer" } });
    await subject.build();
    await subject.review();
    expect(subject.reviewerSeen[0]!.model).not.toBe("p/cheap-reviewer");
  });
});
