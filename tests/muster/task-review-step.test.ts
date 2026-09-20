import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import type { AgentRun } from "../../extensions/fusion-harness/modules/runtime.ts";
import {
  FOCUS_DIFF_LIMIT_BYTES,
  changedPathsOfDiff,
  excerptDiff,
  runReviewStep,
} from "../../src/change/phases/task-steps/review.ts";
import type { TaskStepContext } from "../../src/change/phases/task-steps/context.ts";
import { readSourceDigest } from "../../src/execution/change-digests.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import type { TaskPipelineBuilderResult } from "../../src/execution/task-runner.ts";
import type { ValidatedTask } from "../../src/execution/task-schema.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type {
  JudgmentAnswers,
  JudgmentClient,
  JudgmentClientRequest,
  JudgmentUnavailableReason,
} from "../../src/judgment/client.ts";
import { TASK_FOCUS_QUESTION_IDS as IDS } from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import type { TaskCodeReview } from "../../src/review/code-review.ts";
import { createTaskCodeReview } from "../../src/review/code-review.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const passing: JudgmentAnswers = {
  [IDS.scopeContainment]: noul(0.95),
  [IDS.contractMatch]: noul(0.95),
  [IDS.scenarioCoverage]: noul(0.95),
  [IDS.testFirstConsistency]: noul(0.95),
  [IDS.stubOrHardcoded]: noul(0.05),
  [IDS.securityBoundary]: noul(0.05),
  [IDS.reach]: { type: "score", score: 0.2, probabilities: { "0": 0.1 }, confidence: 0.9 },
};
const missingScenario: JudgmentAnswers = { ...passing, [IDS.scenarioCoverage]: noul(0.1) };
const FOCUS_HEADING = "REVIEW FOCUS (advisory)";

const stack = synthesizeLegacyStack({
  architectModel: "openai/architect",
  builderModel: "openai/builder",
  architectThinking: "high",
  builderThinking: "high",
});

const task = {
  id: "1.1",
  description: "Add the widget",
  requirements: ["Widgets render"],
  scenarios: ["Widget renders"],
  reads: ["src/**"],
  writes: ["src/**"],
} as unknown as ValidatedTask;

const builder = { tddEvidence: { disposition: "required" } } as unknown as TaskPipelineBuilderResult;
const verification = { passed: true, evidence: ["bun test: pass"] };

function git(cwd: string, ...args: string[]): void {
  // Fixed dates make HEAD, and so the source digest, identical across repositories built in different seconds.
  const pinned = { GIT_AUTHOR_DATE: "2026-09-19T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-19T00:00:00Z" };
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, ...pinned } });
}

async function makeRepo(changed: Record<string, string> = { "src/widget.ts": "export const widget = 2;\n" }) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-review-step-"));
  roots.push(root);
  const repo = resolve(root, "repo");
  execFileSync("mkdir", ["-p", resolve(repo, "src")]);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  for (const path of Object.keys(changed)) {
    execFileSync("mkdir", ["-p", resolve(repo, path, "..")]);
    await writeFile(resolve(repo, path), "original\n");
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  for (const [path, content] of Object.entries(changed)) await writeFile(resolve(repo, path), content);
  return { root, repo, store: new AtomicJsonStore(resolve(root, "runs")) };
}

interface Harness {
  prompts: string[];
  reviewerRuns: number;
  requests: JudgmentClientRequest[];
  step: TaskStepContext;
  run: (verdict?: "approve" | "revise") => Promise<Awaited<ReturnType<typeof runReviewStep>>>;
  records: () => ReturnType<typeof listDecisionRecords>;
}

type ClientBehavior = { answers: JudgmentAnswers } | { unavailable: JudgmentUnavailableReason };

async function harness(options: {
  files?: Record<string, string>;
  judgment?: { mode: "shadow" | "enforce"; client: ClientBehavior; budget?: unknown } | "disabled" | "absent";
  reviewFindings?: TaskCodeReview["findings"];
  evidence?: readonly string[];
}): Promise<Harness> {
  const { root, repo, store } = await makeRepo(options.files);
  const requests: JudgmentClientRequest[] = [];
  const setting = options.judgment ?? "absent";
  let judgment: TaskStepContext["judgment"];
  if (setting !== "absent") {
    const client: JudgmentClient = {
      async request(request) {
        requests.push(request);
        if (setting === "disabled") throw new Error("disabled judgment must not send");
        return "answers" in setting.client
          ? { available: true, answers: setting.client.answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 0, durationMs: 1 }
          : { available: false, reason: setting.client.unavailable, durationMs: 1 };
      },
    };
    judgment = createJudgmentRuntime({
      env: setting === "disabled" ? {} : { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: setting.mode },
      store,
      client,
      budget: setting === "disabled" ? undefined : setting.budget as never,
    });
  }
  const step: TaskStepContext = { runId: "run-1", changeName: "add-widget", planningCwd: root, store, stack, judgment };
  const prompts: string[] = [];
  const state = { reviewerRuns: 0 };
  return {
    prompts,
    get reviewerRuns() { return state.reviewerRuns; },
    requests,
    step,
    async run(verdict = "approve") {
      const { sourceDigest } = await readSourceDigest(new GitAdapter(repo));
      const findings = options.reviewFindings
        ?? (verdict === "revise" ? [{ severity: "required" as const, area: "contract" as const, message: "Widget is wrong" }] : []);
      return runReviewStep(
        step,
        task,
        { worktree: { path: repo }, writerLease: null } as never,
        builder,
        options.evidence ? { passed: true, evidence: options.evidence } : verification,
        undefined,
        (async (childOptions: { prompt: string; run: AgentRun }) => {
          state.reviewerRuns += 1;
          prompts.push(childOptions.prompt);
          childOptions.run.exitCode = 0;
          childOptions.run.text = JSON.stringify(createTaskCodeReview({
            runId: "run-1",
            taskId: "1.1",
            reviewedAt: "2026-09-19T10:00:00.000Z",
            model: childOptions.run.model,
            sourceDigest,
            findings,
          }));
          childOptions.run.toolNames = ["muster_read"];
        }) as never,
      );
    },
    records: () => listDecisionRecords(store, "add-widget"),
  };
}

async function baselinePrompt(files?: Record<string, string>): Promise<string> {
  const plain = await harness({ files });
  await plain.run();
  return plain.prompts[0]!;
}

describe("task review focus in the review step", () => {
  test("enforce mode adds the focus block and nothing else", async () => {
    const baseline = await baselinePrompt();
    const focused = await harness({ judgment: { mode: "enforce", client: { answers: missingScenario } } });
    await focused.run();
    const prompt = focused.prompts[0]!;
    expect(prompt).toContain(FOCUS_HEADING);
    expect(prompt).toContain("- Whether the tests exercise each of the task's scenarios");
    expect(prompt.replace(/\n\nREVIEW FOCUS \(advisory\)[\s\S]*?(?=\n\nReturn exactly)/, "")).toBe(baseline);
  });

  test("shadow mode leaves the prompt unchanged and records the items that would have been given", async () => {
    const baseline = await baselinePrompt();
    const shadow = await harness({ judgment: { mode: "shadow", client: { answers: missingScenario } } });
    await shadow.run();
    expect(shadow.prompts[0]).toBe(baseline);
    const [record] = await shadow.records();
    expect(record).toMatchObject({ mode: "shadow", wouldHaveActed: true, acted: false });
    expect(record!.gate).toMatchObject({ act: true, value: { items: [{ id: IDS.scenarioCoverage }] } });
  });

  test("every unavailable reason yields today's prompt", async () => {
    const baseline = await baselinePrompt();
    const reasons: JudgmentUnavailableReason[] = ["timeout", "rate_limit", "network", "server", "invalid_response", "model_mismatch", "aborted"];
    for (const reason of reasons) {
      const run = await harness({ judgment: { mode: "enforce", client: { unavailable: reason } } });
      await run.run();
      expect(run.prompts[0]).toBe(baseline);
      expect((await run.records())[0]).toMatchObject({ status: "unavailable", unavailableReason: reason });
    }
    const budget = await harness({
      judgment: { mode: "enforce", client: { answers: missingScenario }, budget: { forecast: () => ({ status: "blocked_optional", reason: "over" }) } },
    });
    await budget.run();
    expect(budget.prompts[0]).toBe(baseline);
    expect((await budget.records())[0]).toMatchObject({ unavailableReason: "budget" });
  });

  test("a state too large to send leaves the prompt unchanged", async () => {
    const evidence = ["y".repeat(200_000)];
    const plain = await harness({ evidence });
    await plain.run();
    const big = await harness({ evidence, judgment: { mode: "enforce", client: { answers: missingScenario } } });
    await big.run();
    expect(big.requests).toHaveLength(0);
    expect(big.prompts[0]).toBe(plain.prompts[0]);
    expect((await big.records())[0]).toMatchObject({ unavailableReason: "state_too_large" });
  });

  test("a denied changed path sends nothing and leaves the prompt unchanged", async () => {
    const files = { "src/widget.ts": "export const widget = 2;\n", ".env": "TOKEN=abc\n" };
    const plain = await harness({ files });
    await plain.run();
    const denied = await harness({ files, judgment: { mode: "enforce", client: { answers: missingScenario } } });
    await denied.run();
    expect(denied.requests).toHaveLength(0);
    expect(denied.prompts[0]).toBe(plain.prompts[0]);
    expect((await denied.records())[0]).toMatchObject({ unavailableReason: "state_denied" });
  });

  test("disabled judgment sends nothing and writes no record", async () => {
    const baseline = await baselinePrompt();
    const disabled = await harness({ judgment: "disabled" });
    await disabled.run();
    expect(disabled.requests).toHaveLength(0);
    expect(await disabled.records()).toEqual([]);
    expect(disabled.prompts[0]).toBe(baseline);
  });

  test("the reviewer still runs when judgment answers that every check passes", async () => {
    const baseline = await baselinePrompt();
    const passed = await harness({ judgment: { mode: "enforce", client: { answers: passing } } });
    const result = await passed.run();
    expect(passed.reviewerRuns).toBe(1);
    expect(passed.prompts[0]).toBe(baseline);
    expect(result.approved).toBeTrue();
  });

  test("approval follows the reviewer's verdict in both directions", async () => {
    const calm = await harness({ judgment: { mode: "enforce", client: { answers: passing } } });
    const blocked = await calm.run("revise");
    expect(blocked).toEqual({ approved: false, findings: ["Widget is wrong"] });

    const alarmed = await harness({ judgment: { mode: "enforce", client: { answers: missingScenario } } });
    const approved = await alarmed.run("approve");
    expect(alarmed.prompts[0]).toContain(FOCUS_HEADING);
    expect(approved).toEqual({ approved: true, findings: [] });
  });

  test("the record is reconciled with the finding counts, the areas raised, and the focus items that named one", async () => {
    const run = await harness({
      judgment: { mode: "enforce", client: { answers: { ...missingScenario, [IDS.contractMatch]: noul(0.1) } } },
      reviewFindings: [
        { severity: "required", area: "tests", message: "Scenario untested" },
        { severity: "recommendation", area: "tests", message: "Name the test better" },
        { severity: "recommendation", area: "diff", message: "Tidy" },
      ],
    });
    await run.run();
    const [record] = await run.records();
    expect(record!.observed).toEqual({
      requiredFindings: 1,
      recommendations: 2,
      areasRaised: ["diff", "tests"],
      focusItemsRaised: [IDS.scenarioCoverage],
    });
  });

  test("shadow records are reconciled too, against the items that would have been given", async () => {
    const run = await harness({
      judgment: { mode: "shadow", client: { answers: missingScenario } },
      reviewFindings: [{ severity: "required", area: "tests", message: "Scenario untested" }],
    });
    await run.run();
    const [record] = await run.records();
    expect(record!.observed).toMatchObject({ requiredFindings: 1, focusItemsRaised: [IDS.scenarioCoverage] });
  });

  test("an oversized diff is excerpted within the limit and the state keeps every changed path", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 8; index += 1) files[`src/file-${index}.ts`] = `${"// line\n".repeat(700)}`;
    const run = await harness({ files, judgment: { mode: "enforce", client: { answers: passing } } });
    await run.run();
    const state = run.requests[0]!.state as { diffExcerpt: string; changedPaths: string[] };
    expect(Buffer.byteLength(state.diffExcerpt)).toBeLessThanOrEqual(FOCUS_DIFF_LIMIT_BYTES);
    expect(state.diffExcerpt.length).toBeGreaterThan(0);
    expect(state.changedPaths).toEqual(Object.keys(files).sort());
    // The reviewer itself still gets the whole diff.
    expect(run.prompts[0]).toContain("src/file-7.ts");
  });
});

describe("diff helpers", () => {
  const file = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

  test("changed paths come from the diff headers, including renames and spaces", () => {
    const diff = [
      file("src/a.ts", "+a\n"),
      file("src/with space.ts", "+b\n"),
      "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n",
      file("src/a.ts", "+again\n"),
    ].join("");
    expect(changedPathsOfDiff(diff)).toEqual(["src/a.ts", "src/with space.ts", "old.ts", "new.ts"]);
    expect(changedPathsOfDiff("")).toEqual([]);
  });

  test("the excerpt keeps whole leading files within the limit", () => {
    const first = file("a.ts", "+1\n");
    const second = file("b.ts", "+2\n");
    const both = first + second;
    expect(excerptDiff(both, Buffer.byteLength(both))).toBe(both);
    expect(excerptDiff(both, Buffer.byteLength(first))).toBe(first);
    expect(excerptDiff(both, Buffer.byteLength(first) - 1)).toBe("");
  });
});
