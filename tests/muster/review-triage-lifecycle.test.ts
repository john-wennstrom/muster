import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import { runProductionReview } from "../../src/change/phases/review.ts";
import { resolveChangeAction } from "../../src/controller/action-resolver.ts";
import { createChangeSnapshot, type ChangeSnapshotInput } from "../../src/controller/change-snapshot.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { REVIEW_TRIAGE_CHANGE_QUESTION_IDS, REVIEW_TRIAGE_QUESTION_IDS } from "../../src/judgment/questions.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../../src/review/artifact-digest.ts";
import { parseReviewArtifact } from "../../src/review/review-artifact.ts";
import { openSpecFor, writeValidPlan } from "../helpers/plan-fixture.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const observedAt = "2026-09-20T10:00:00.000Z";

const immaterial: JudgmentAnswers = {
  [REVIEW_TRIAGE_QUESTION_IDS.materiality]: {
    type: "score", score: 0, probabilities: { "0": 0.95 }, confidence: 0.95,
  },
  ...Object.fromEntries(REVIEW_TRIAGE_CHANGE_QUESTION_IDS.map((id) => [id, { type: "noul", noul: 0.05 }])),
};

async function setup(env: Record<string, string>) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-review-triage-lifecycle-"));
  roots.push(root);
  const changeRoot = resolve(root, "openspec", "changes", "add-search");
  await mkdir(changeRoot, { recursive: true });
  await writeValidPlan(changeRoot);
  await writeFile(resolve(changeRoot, "proposal.md"), "# Proposal\n\nAdd serch.\n");
  const store = new AtomicJsonStore(resolve(root, ".fusion", "runs"));
  const judgment = createJudgmentRuntime({
    env,
    store,
    client: {
      async request() {
        return { available: true, answers: immaterial, model: "jev-1", inputTokens: 100, outputTokens: 0, durationMs: 1 };
      },
    },
  });
  let reviewerCalls = 0;
  const run = () => runProductionReview({
    cwd: root,
    changeName: "add-search",
    runId: "review-run",
    openSpec: openSpecFor(changeRoot),
    modelStack: synthesizeLegacyStack({
      architectModel: "openai/architect",
      builderModel: "openai/reviewer",
      architectThinking: "high",
      builderThinking: "high",
    }),
    judgment,
    env,
    now: () => new Date(observedAt),
    runner: async () => {
      reviewerCalls += 1;
      return {
        review: { verdict: "APPROVE", criticalFindings: [], requiredChanges: [], recommendations: ["Keep it small."] },
        toolNames: ["muster_read"],
      };
    },
  });
  const persisted = async () =>
    parseReviewArtifact(await readFile(resolve(changeRoot, "review.md"), "utf8"), resolve(changeRoot, "review.md"));
  const lifecycle = async () => {
    const digest = await hashReviewedArtifacts(await discoverReviewedArtifacts(root, changeRoot));
    const input: ChangeSnapshotInput = {
      capturedAt: observedAt,
      openSpec: { observedAt, changeName: "add-search", planningComplete: true, tasks: { "1.1": false }, artifactDigest: digest },
      repository: {
        observedAt, repositoryId: "repo-1", commonDirectory: "/repo/.git", worktree: "/repo", head: "a".repeat(40),
        indexDigest: "index", diffDigest: "diff", sourceDigest: "source",
      },
      runtime: null,
      review: { observedAt, artifact: await persisted() },
      validation: null,
      pendingCheckpointIds: [],
    };
    const snapshot = createChangeSnapshot(input);
    return { digest, snapshot };
  };
  return { changeRoot, run, persisted, lifecycle, reviewerCalls: () => reviewerCalls };
}

const enabled = {
  MUSTER_JEV: "1",
  MUSTER_JEV_API_KEY: "key",
  MUSTER_JEV_MODE: "enforce",
};

describe("review triage in the review phase", () => {
  test("a carried-forward approval is a current approval of the current digest, like any other", async () => {
    const context = await setup(enabled);
    const full = await context.run();
    expect(full).toMatchObject({ status: "success", action: "review" });
    expect(full.summary).toBe("Planning review APPROVE persisted for 4 artifact(s).");
    const fullState = await context.lifecycle();
    expect(fullState.snapshot.lifecycle).toBe("READY");

    await writeFile(resolve(context.changeRoot, "proposal.md"), "# Proposal\n\nAdd search.\n");
    const carried = await context.run();

    expect(context.reviewerCalls()).toBe(1);
    const review = await context.persisted();
    const state = await context.lifecycle();
    expect(review.carriedForward).toBeDefined();
    expect(review.artifactDigest).toBe(state.digest);
    expect(state.digest).not.toBe(fullState.digest);
    expect(state.snapshot.freshness.review).toBe("current");
    expect(state.snapshot.lifecycle).toBe(fullState.snapshot.lifecycle);
    expect(resolveChangeAction("implement", state.snapshot).allowed).toBe(true);
    expect(carried).toMatchObject({ status: "success", action: "review", next: "/change implement add-search" });
  });

  test("the outcome names the basis, the count, and how to get a full review", async () => {
    const context = await setup(enabled);
    await context.run();
    const basis = await context.persisted();
    await writeFile(resolve(context.changeRoot, "proposal.md"), "# Proposal\n\nAdd search.\n");

    const carried = await context.run();

    expect(carried.summary).toContain("carried forward");
    expect(carried.summary).toContain("no reviewer ran");
    expect(carried.summary).toContain(basis.artifactDigest.slice(0, 12));
    expect(carried.summary).toContain("carry-forward 1 of 3");
    expect(carried.summary).toContain("/change review add-search");

    await writeFile(resolve(context.changeRoot, "proposal.md"), "# Proposal\n\nAdd search, please.\n");
    expect((await context.run()).summary).toContain("carry-forward 2 of 3");
  });

  test("without judgment every changed artifact set gets a full review, and nothing is retained", async () => {
    const context = await setup({});
    await context.run();
    await writeFile(resolve(context.changeRoot, "proposal.md"), "# Proposal\n\nAdd search.\n");
    const second = await context.run();

    expect(context.reviewerCalls()).toBe(2);
    expect(second.summary).toBe("Planning review APPROVE persisted for 4 artifact(s).");
    expect((await context.persisted()).carriedForward).toBeUndefined();
  });

  test("a specification edit is never carried forward", async () => {
    const context = await setup(enabled);
    await context.run();
    await appendFile(resolve(context.changeRoot, "specs", "toolbar-search", "spec.md"), "\nThe palette SHALL search.\n");
    const second = await context.run();

    expect(context.reviewerCalls()).toBe(2);
    expect(second.summary).not.toContain("carried forward");
  });
});
