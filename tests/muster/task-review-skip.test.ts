import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import type { AgentRun } from "../../src/agents/run-record.ts";
import type { TaskStepContext } from "../../src/change/phases/task-steps/context.ts";
import { runReviewStep } from "../../src/change/phases/task-steps/review.ts";
import { writeLane, type Lane } from "../../src/controller/lane.ts";
import { readSourceDigest } from "../../src/execution/change-digests.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import { recordFailure } from "../../src/execution/recovery.ts";
import type { ValidatedTask } from "../../src/execution/task-schema.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type { JudgmentAnswers, JudgmentClient, JudgmentUnavailableReason } from "../../src/judgment/client.ts";
import { TASK_FOCUS_QUESTION_IDS as IDS } from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { createTaskCodeReview } from "../../src/review/code-review.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const good: JudgmentAnswers = {
  [IDS.scopeContainment]: noul(0.95), [IDS.contractMatch]: noul(0.95), [IDS.scenarioCoverage]: noul(0.95),
  [IDS.testFirstConsistency]: noul(0.95), [IDS.stubOrHardcoded]: noul(0.05), [IDS.securityBoundary]: noul(0.05),
  [IDS.reach]: { type: "score", score: 0.2, probabilities: { "0": 0.1 }, confidence: 0.9 },
};

const stack = synthesizeLegacyStack({ architectModel: "p/architect", builderModel: "p/builder", architectThinking: "high", builderThinking: "high" });
const task = {
  id: "1.1", description: "Add the widget", requirements: ["Widgets render"], scenarios: ["Widget renders"],
  reads: ["src/**"], writes: ["src/**"],
} as unknown as ValidatedTask;

interface Options {
  answers?: JudgmentAnswers;
  unavailable?: JudgmentUnavailableReason;
  mode?: "enforce" | "shadow";
  lane?: Lane;
  files?: Record<string, string>;
  firstAttempt?: boolean;
  priorFailure?: boolean;
  verified?: boolean;
  tdd?: boolean;
  writes?: string[];
}

async function harness(options: Options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-review-skip-"));
  roots.push(root);
  const repo = resolve(root, "repo");
  const files = options.files ?? { "src/widget.ts": "export const widget = 2;\n" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  await mkdir(repo, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  for (const path of Object.keys(files)) {
    await mkdir(dirname(resolve(repo, path)), { recursive: true });
    await writeFile(resolve(repo, path), "original\n");
  }
  git("add", ".");
  git("commit", "-q", "-m", "init");
  for (const [path, content] of Object.entries(files)) await writeFile(resolve(repo, path), content);
  const store = new AtomicJsonStore(resolve(root, "runs"));
  if (options.lane) await writeLane(store, "add-widget", { lane: options.lane, source: "user", reasons: ["fixture"] });
  if (options.priorFailure) {
    await recordFailure(store, "add-widget", "1.1", {
      attempt: 1, outcome: "blocked", evidence: ["failed"], reproduction: null, changedPaths: [], recordedAt: "2026-09-21T10:00:00.000Z",
    });
  }
  const client: JudgmentClient = {
    async request() {
      return options.unavailable
        ? { available: false, reason: options.unavailable, durationMs: 1 }
        : { available: true, answers: options.answers ?? good, model: "jev-1", inputTokens: 100, outputTokens: 0, durationMs: 1 };
    },
  };
  const step: TaskStepContext = {
    runId: "run-1", changeName: "add-widget", planningCwd: root, store, stack,
    judgment: createJudgmentRuntime({ env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: options.mode ?? "enforce" }, store, client }),
    routing: options.firstAttempt === false ? new Map() : new Map([["1.1", { economy: false, builderThinking: "high", reviewerThinking: "high" }]]),
  };
  let reviewerRuns = 0;
  const run = async () => {
    const { sourceDigest } = await readSourceDigest(new GitAdapter(repo));
    return runReviewStep(
      step, options.writes ? { ...task, writes: options.writes } : task, { worktree: { path: repo }, writerLease: null } as never,
      options.tdd === false ? ({} as never) : ({ tddEvidence: { disposition: "required" } } as never),
      { passed: options.verified !== false, evidence: ["bun test: pass"] }, undefined,
      (async (child: { run: AgentRun }) => {
        reviewerRuns += 1;
        child.run.exitCode = 0;
        child.run.text = JSON.stringify(createTaskCodeReview({ runId: "run-1", taskId: "1.1", reviewedAt: "2026-09-21T10:00:00.000Z", model: child.run.model, sourceDigest, findings: [] }));
        child.run.toolNames = ["muster_read"];
      }) as never,
    );
  };
  return { run, reviewerRuns: () => reviewerRuns, records: () => listDecisionRecords(store, "add-widget") };
}

describe("skipping a task review", () => {
  test("every guard holding skips the reviewer, approves, and names the decision record", async () => {
    const subject = await harness();
    const result = await subject.run();
    const [record] = await subject.records();

    expect(subject.reviewerRuns()).toBe(0);
    expect(result).toEqual({ approved: true, findings: [], skipped: { decisionRecordId: record!.recordId } });
    expect(record).toMatchObject({ decision: "review.task_focus", acted: true });
    expect(record!.observed).toMatchObject({ skippedReview: true });
  });

  test("one uncertain answer runs the reviewer", async () => {
    const subject = await harness({ answers: { ...good, [IDS.contractMatch]: noul(0.5) } });
    const result = await subject.run();
    expect(subject.reviewerRuns()).toBe(1);
    expect(result.skipped).toBeUndefined();
  });

  test("a changed path outside the write scope runs the reviewer", async () => {
    const subject = await harness({ files: { "src/widget.ts": "2\n", "docs/notes.md": "2\n" } });
    expect((await subject.run()).skipped).toBeUndefined();
    expect(subject.reviewerRuns()).toBe(1);
    const [record] = await subject.records();
    expect(JSON.stringify(record!.observed)).toContain("docs/notes.md");
  });

  test("a denylisted changed path runs the reviewer", async () => {
    // Inside the write scope, so only the denylist can refuse it.
    const subject = await harness({ files: { ".env": "SECRET=1\n" }, writes: ["**"] });
    expect((await subject.run()).skipped).toBeUndefined();
    expect(subject.reviewerRuns()).toBe(1);
  });

  test("a retry is always reviewed, in this run and on a later invocation", async () => {
    const inRun = await harness({ firstAttempt: false });
    expect((await inRun.run()).skipped).toBeUndefined();
    expect(inRun.reviewerRuns()).toBe(1);

    const later = await harness({ priorFailure: true });
    expect((await later.run()).skipped).toBeUndefined();
    expect(later.reviewerRuns()).toBe(1);
  });

  test("failed verification, or no accepted test-first evidence, runs the reviewer", async () => {
    const unverified = await harness({ verified: false });
    await unverified.run();
    expect(unverified.reviewerRuns()).toBe(1);

    const untested = await harness({ tdd: false });
    await untested.run();
    expect(untested.reviewerRuns()).toBe(1);
  });

  test("the large lane always runs the reviewer", async () => {
    const subject = await harness({ lane: "large" });
    expect((await subject.run()).skipped).toBeUndefined();
    expect(subject.reviewerRuns()).toBe(1);
  });

  test("shadow mode runs the reviewer and records that the review would have been skipped", async () => {
    const subject = await harness({ mode: "shadow" });
    const result = await subject.run();
    const [record] = await subject.records();

    expect(subject.reviewerRuns()).toBe(1);
    expect(result.skipped).toBeUndefined();
    expect(record!.observed).toMatchObject({ wouldHaveSkipped: true });
  });

  test("shadow mode with a guard failing does not claim a skip", async () => {
    const subject = await harness({ mode: "shadow", lane: "large" });
    await subject.run();
    const [record] = await subject.records();
    expect(record!.observed).not.toHaveProperty("wouldHaveSkipped");
  });

  test("an unavailable service runs the reviewer", async () => {
    const subject = await harness({ unavailable: "network" });
    expect((await subject.run()).skipped).toBeUndefined();
    expect(subject.reviewerRuns()).toBe(1);
  });
});
