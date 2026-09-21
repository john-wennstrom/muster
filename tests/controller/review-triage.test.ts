import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { reviewChange, type ReviewChangeResult } from "../../src/controller/review.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type {
  JudgmentAnswers,
  JudgmentClientRequest,
  JudgmentClientResult,
  JudgmentUnavailableReason,
} from "../../src/judgment/client.ts";
import { REVIEW_TRIAGE_CHANGE_QUESTION_IDS, REVIEW_TRIAGE_QUESTION_IDS } from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { changeRunId } from "../../src/persistence/change-usage-store.ts";
import type { PlanningReviewerRunner } from "../../src/review/planning-reviewer.ts";
import { parseReviewArtifact, type PlanningReviewArtifact } from "../../src/review/review-artifact.ts";
import { REVIEW_SNAPSHOT_DIRECTORY } from "../../src/review/review-snapshot.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const scored = (score: number, confidence: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 1 - confidence },
  confidence,
});

/** Wording only, confidently, with nothing changed: the answers that let an approval be carried. */
function immaterial(overrides: JudgmentAnswers = {}): JudgmentAnswers {
  return {
    [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(0, 0.95),
    ...Object.fromEntries(REVIEW_TRIAGE_CHANGE_QUESTION_IDS.map((id) => [id, noul(0.05)])),
    ...overrides,
  };
}

const enabledEnv = {
  MUSTER_JEV: "1",
  MUSTER_JEV_API_KEY: "key",
  MUSTER_JEV_MODE: "enforce",
};

interface Harness {
  repositoryRoot: string;
  changeRoot: string;
  store: AtomicJsonStore;
  /** The answer the judgment client gives next; a function for a client that misbehaves. */
  answer: JudgmentAnswers | ((request: JudgmentClientRequest) => JudgmentClientResult | Promise<JudgmentClientResult>);
  /** The verdict the reviewer gives next. */
  verdict: "APPROVE" | "REVISE";
  reviewerCalls: number;
  reviewerPrompts: string[];
  judgmentRequests: JudgmentClientRequest[];
  env: Record<string, string>;
  review(options?: { prompt?: string; triage?: boolean }): Promise<ReviewChangeResult>;
  edit(file: string, contents: string): Promise<void>;
  read(): Promise<PlanningReviewArtifact>;
  snapshotFiles(): Promise<string[]>;
}

async function harness(env: Record<string, string> = enabledEnv): Promise<Harness> {
  const repositoryRoot = await mkdtemp(resolve(tmpdir(), "muster-review-triage-"));
  temporaryDirectories.push(repositoryRoot);
  const changeRoot = resolve(repositoryRoot, "openspec", "changes", "add-search");
  await mkdir(resolve(changeRoot, "specs", "search"), { recursive: true });
  await Promise.all([
    writeFile(resolve(changeRoot, "proposal.md"), "# Proposal\n\nAdd serch to the palette.\n"),
    writeFile(resolve(changeRoot, "design.md"), "# Design\n\nUse one module.\n"),
    writeFile(resolve(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] 1.1 Add search\n"),
    writeFile(resolve(changeRoot, "specs", "search", "spec.md"), "# Search\n\nThe palette SHALL search.\n"),
  ]);
  const store = new AtomicJsonStore(resolve(repositoryRoot, ".store"));

  const state: Harness = {
    repositoryRoot,
    changeRoot,
    store,
    answer: immaterial(),
    verdict: "APPROVE",
    reviewerCalls: 0,
    reviewerPrompts: [],
    judgmentRequests: [],
    env,
    async review(options = {}) {
      const runtime = createJudgmentRuntime({
        env: state.env,
        store,
        client: {
          async request(request) {
            state.judgmentRequests.push(request);
            if (typeof state.answer === "function") return state.answer(request);
            return { available: true, answers: state.answer, model: "jev-1", inputTokens: 100, outputTokens: 0, durationMs: 1 };
          },
        },
      });
      const runner: PlanningReviewerRunner = async (request) => {
        state.reviewerCalls += 1;
        state.reviewerPrompts.push(request.prompt);
        return {
          review: {
            verdict: state.verdict,
            criticalFindings: [],
            requiredChanges: state.verdict === "REVISE" ? ["Fix the design."] : [],
            recommendations: ["Keep the palette in one module."],
          },
          toolNames: ["muster_read"],
        };
      };
      let tick = 0;
      return reviewChange({
        repositoryRoot,
        changeRoot,
        changeName: "add-search",
        runId: "run-1",
        sessionsRoot: resolve(repositoryRoot, ".fusion", "sessions"),
        author: { model: "openai/author", sessionId: "author-session" },
        candidates: [{ model: "openai/reviewer", available: true }],
        runner,
        prompt: options.prompt,
        judgment: { runtime, store },
        ...(options.triage === false ? {} : { triage: { runtime, store } }),
      }, { now: () => new Date(Date.parse("2026-09-20T12:00:00.000Z") + (tick += 1000)) });
    },
    edit: (file, contents) => writeFile(resolve(changeRoot, file), contents),
    async read() {
      return parseReviewArtifact(await readFile(resolve(changeRoot, "review.md"), "utf8"), "review.md");
    },
    async snapshotFiles() {
      try {
        return await readdir(resolve(store.runsRoot, changeRunId("add-search"), REVIEW_SNAPSHOT_DIRECTORY));
      } catch {
        return [];
      }
    },
  };
  return state;
}

/** An approved full review with a retained copy, ready for an edit. */
async function approved(env?: Record<string, string>): Promise<Harness> {
  const context = await harness(env);
  const first = await context.review();
  expect(first.review.verdict).toBe("APPROVE");
  expect(context.reviewerCalls).toBe(1);
  return context;
}

describe("review triage retention", () => {
  test("an approving full review retains the approved prose and every file's digest", async () => {
    const context = await approved();
    const review = await context.read();
    expect(await context.snapshotFiles()).toEqual([`${review.artifactDigest}.json`]);
    const saved = JSON.parse(await readFile(
      resolve(context.store.runsRoot, changeRunId("add-search"), REVIEW_SNAPSHOT_DIRECTORY, `${review.artifactDigest}.json`),
      "utf8",
    ));
    expect(Object.keys(saved.files)).toHaveLength(4);
    expect(saved.proposal.text).toContain("Add serch");
    expect(JSON.stringify(saved)).not.toContain("The palette SHALL search");
  });

  test("a revising full review retains nothing", async () => {
    const context = await harness();
    context.verdict = "REVISE";
    await context.review();
    expect(await context.snapshotFiles()).toEqual([]);
  });

  test("nothing is retained and nothing is asked when triage is not enabled", async () => {
    const context = await harness();
    await context.review({ triage: false });
    expect(await context.snapshotFiles()).toEqual([]);

    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    await context.review({ triage: false });
    expect(context.judgmentRequests).toHaveLength(0);
    expect(context.reviewerCalls).toBe(2);
    expect(await listDecisionRecords(context.store, "add-search")).toEqual([]);
  });

  test("nothing is retained when the runtime is disabled", async () => {
    const context = await harness({});
    await context.review();
    expect(await context.snapshotFiles()).toEqual([]);
    expect(context.judgmentRequests).toHaveLength(0);
  });

  test("the first edit after enabling triage gets a full review, since no copy exists yet", async () => {
    const context = await harness();
    await context.review({ triage: false });
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    const result = await context.review();
    expect(context.reviewerCalls).toBe(2);
    expect(context.judgmentRequests).toHaveLength(0);
    expect(result.review.carriedForward).toBeUndefined();
    expect(await context.snapshotFiles()).toHaveLength(1);
  });
});

describe("review triage carry-forward", () => {
  test("carries an immaterial edit forward without dispatching a reviewer", async () => {
    const context = await approved();
    const basis = await context.read();
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");

    const result = await context.review();

    expect(context.reviewerCalls).toBe(1);
    expect(result.assignment).toBeNull();
    expect(result.nextAction).toBe("implement");
    expect(result.reviewedPaths).toHaveLength(4);
    const persisted = await context.read();
    expect(persisted).toEqual(result.review);
    expect(persisted.verdict).toBe("APPROVE");
    expect(persisted.round).toBe(basis.round + 1);
    expect(persisted.model).toBe(basis.model);
    expect(persisted.recommendations).toEqual(basis.recommendations);
    expect(persisted.artifactDigest).not.toBe(basis.artifactDigest);
    expect(persisted.carriedForward).toMatchObject({ basisDigest: basis.artifactDigest, count: 1 });
    expect(persisted.carriedForward!.evidence[0]).toBe("materiality: 0 (confidence 0.95)");
    expect(persisted.carriedForward!.evidence).toHaveLength(6);

    const [record] = await listDecisionRecords(context.store, "add-search");
    expect(persisted.carriedForward!.recordId).toBe(record!.recordId);
    expect(record).toMatchObject({ decision: "review.triage", acted: true, wouldHaveActed: true });
  });

  test("what is sent is only the two prose diffs and the previous recommendations", async () => {
    const context = await approved();
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    await context.review();

    expect(context.judgmentRequests).toHaveLength(1);
    const state = context.judgmentRequests[0]!.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["designDiff", "previousRecommendations", "proposalDiff"]);
    expect(state.proposalDiff).toContain("-Add serch to the palette.");
    expect(state.proposalDiff).toContain("+Add search to the palette.");
    expect(state.designDiff).toBe("");
    expect(state.previousRecommendations).toEqual(["Keep the palette in one module."]);
    expect(JSON.stringify(state)).not.toContain("SHALL search");
    expect(JSON.stringify(state)).not.toContain("1.1 Add search");
  });

  test("consecutive carry-forwards are compared against the last full review and counted", async () => {
    const context = await approved();
    const basis = await context.read();
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    await context.review();
    await context.edit("design.md", "# Design\n\nUse one module for it.\n");
    const second = await context.review();

    expect(context.reviewerCalls).toBe(1);
    expect(second.review.carriedForward).toMatchObject({ basisDigest: basis.artifactDigest, count: 2 });
    // The second judgment saw the whole drift since the approval, not just the last edit.
    const state = context.judgmentRequests[1]!.state as Record<string, string>;
    expect(state.proposalDiff).toContain("-Add serch to the palette.");
    expect(state.designDiff).toContain("+Use one module for it.");
    expect(second.review.round).toBe(basis.round + 2);
  });

  test("the fourth consecutive edit gets a full review with no request, and the count restarts", async () => {
    const context = await approved();
    const basis = await context.read();
    for (const [index, text] of ["one", "two", "three"].entries()) {
      await context.edit("proposal.md", `# Proposal\n\nAdd search, take ${text}.\n`);
      const result = await context.review();
      expect(result.review.carriedForward?.count).toBe(index + 1);
    }
    expect(context.reviewerCalls).toBe(1);
    expect(context.judgmentRequests).toHaveLength(3);

    await context.edit("proposal.md", "# Proposal\n\nAdd search, take four.\n");
    const full = await context.review();
    expect(context.judgmentRequests).toHaveLength(3);
    expect(context.reviewerCalls).toBe(2);
    expect(full.assignment).not.toBeNull();
    expect(full.review.carriedForward).toBeUndefined();
    expect((await context.read()).carriedForward).toBeUndefined();

    await context.edit("proposal.md", "# Proposal\n\nAdd search, take five.\n");
    const again = await context.review();
    expect(again.review.carriedForward).toMatchObject({ count: 1, basisDigest: full.review.artifactDigest });
    expect(again.review.carriedForward!.basisDigest).not.toBe(basis.artifactDigest);
  });
});

describe("review triage ineligible edits", () => {
  async function expectFullReviewWithoutRequest(context: Harness) {
    const before = context.reviewerCalls;
    const result = await context.review();
    expect(context.judgmentRequests).toHaveLength(0);
    expect(context.reviewerCalls).toBe(before + 1);
    expect(result.review.carriedForward).toBeUndefined();
    expect(await listDecisionRecords(context.store, "add-search")).toEqual([]);
  }

  test("a specification edit", async () => {
    const context = await approved();
    await context.edit("specs/search/spec.md", "# Search\n\nThe palette SHALL search everywhere.\n");
    await expectFullReviewWithoutRequest(context);
  });

  test("a task list edit", async () => {
    const context = await approved();
    await context.edit("tasks.md", "# Tasks\n\n- [ ] 1.1 Add search\n- [ ] 1.2 Add docs\n");
    await expectFullReviewWithoutRequest(context);
  });

  test("a prose edit together with a specification edit", async () => {
    const context = await approved();
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    await context.edit("specs/search/spec.md", "# Search\n\nThe palette SHALL search everywhere.\n");
    await expectFullReviewWithoutRequest(context);
  });

  test("an added specification", async () => {
    const context = await approved();
    await mkdir(resolve(context.changeRoot, "specs", "extra"), { recursive: true });
    await context.edit("specs/extra/spec.md", "# Extra\n");
    await expectFullReviewWithoutRequest(context);
  });

  test("additional review instructions", async () => {
    const context = await approved();
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    await context.review({ prompt: "Look hard at the rollout." });
    expect(context.judgmentRequests).toHaveLength(0);
    expect(context.reviewerCalls).toBe(2);
    expect(context.reviewerPrompts[1]).toContain("Look hard at the rollout.");
  });

  test("a previous review that revised", async () => {
    const context = await harness();
    context.verdict = "REVISE";
    await context.review();
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    context.verdict = "APPROVE";
    await expectFullReviewWithoutRequest(context);
  });

  test("an approved review whose artifacts did not change is reviewed again as it is without triage", async () => {
    const context = await approved();
    await expectFullReviewWithoutRequest(context);
  });

  test("a diff over the cap is not sent", async () => {
    const context = await approved();
    await context.edit("proposal.md", `# Proposal\n\n${"a long new paragraph\n".repeat(1000)}`);
    await expectFullReviewWithoutRequest(context);
  });
});

describe("review triage doubt and failure", () => {
  test("a material edit is not carried forward", async () => {
    const context = await approved();
    context.answer = immaterial({ [REVIEW_TRIAGE_QUESTION_IDS.requirements]: noul(0.4) });
    await context.edit("proposal.md", "# Proposal\n\nAdd search and history to the palette.\n");

    const result = await context.review();

    expect(context.judgmentRequests).toHaveLength(1);
    expect(context.reviewerCalls).toBe(2);
    expect(result.review.carriedForward).toBeUndefined();
  });

  test("uncertain materiality is not carried forward", async () => {
    const context = await approved();
    context.answer = immaterial({ [REVIEW_TRIAGE_QUESTION_IDS.materiality]: scored(0, 0.7) });
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    await context.review();
    expect(context.reviewerCalls).toBe(2);
  });

  for (const reason of [
    "budget", "state_too_large", "timeout", "rate_limit", "network", "server", "invalid_response", "model_mismatch", "aborted",
  ] as const satisfies readonly JudgmentUnavailableReason[]) {
    test(`unavailable for ${reason} gives a full review`, async () => {
      const context = await approved();
      context.answer = async () => ({ available: false, reason: reason === "budget" ? "server" : reason, durationMs: 1 });
      await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");

      const result = await context.review();

      expect(context.reviewerCalls).toBe(2);
      expect(result.review.carriedForward).toBeUndefined();
      expect(result.assignment).not.toBeNull();
    });
  }

  test("a judgment client that throws gives a full review", async () => {
    const context = await approved();
    context.answer = async () => {
      throw new Error("socket closed");
    };
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    const result = await context.review();
    expect(context.reviewerCalls).toBe(2);
    expect(result.review.verdict).toBe("APPROVE");
  });

  test("an unreadable retained copy gives a full review", async () => {
    const context = await approved();
    const review = await context.read();
    await writeFile(
      resolve(context.store.runsRoot, changeRunId("add-search"), REVIEW_SNAPSHOT_DIRECTORY, `${review.artifactDigest}.json`),
      "{ not json",
    );
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    await context.review();
    expect(context.judgmentRequests).toHaveLength(0);
    expect(context.reviewerCalls).toBe(2);
  });

  test("artifacts changing while judgment runs give a full review of what is there now", async () => {
    const context = await approved();
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    context.answer = async () => {
      await context.edit("proposal.md", "# Proposal\n\nAdd search, and rewrite the whole approach.\n");
      return { available: true, answers: immaterial(), model: "jev-1", inputTokens: 100, outputTokens: 0, durationMs: 1 };
    };

    const result = await context.review();

    expect(context.reviewerCalls).toBe(2);
    expect(result.review.carriedForward).toBeUndefined();
    expect(result.assignment).not.toBeNull();
    const reviewed = await context.read();
    expect(context.reviewerPrompts[1]).toContain(reviewed.artifactDigest);
    // What a later edit is compared against is the text the review saw, not the pre-race text.
    const saved = JSON.parse(await readFile(
      resolve(context.store.runsRoot, changeRunId("add-search"), REVIEW_SNAPSHOT_DIRECTORY, `${reviewed.artifactDigest}.json`),
      "utf8",
    ));
    expect(saved.proposal.text).toContain("rewrite the whole approach");
  });

  test("an approving full review after an abstention retains its own copy", async () => {
    const context = await approved();
    context.answer = immaterial({ [REVIEW_TRIAGE_QUESTION_IDS.scopes]: noul(0.9) });
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    const result = await context.review();
    expect(await context.snapshotFiles()).toContain(`${result.review.artifactDigest}.json`);
  });
});

describe("review triage shadow mode", () => {
  const shadow = { ...enabledEnv, MUSTER_JEV_MODE: "shadow" };

  test("always dispatches the reviewer and reconciles an agreeing skip", async () => {
    const context = await approved(shadow);
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");

    const result = await context.review();

    expect(context.reviewerCalls).toBe(2);
    expect(result.assignment).not.toBeNull();
    expect(result.review.carriedForward).toBeUndefined();
    const [record] = await listDecisionRecords(context.store, "add-search");
    expect(record).toMatchObject({
      decision: "review.triage",
      mode: "shadow",
      wouldHaveActed: true,
      acted: false,
      agreement: true,
      observed: { reviewVerdict: "APPROVE", reviewRequiredChanges: 0, reviewCriticalFindings: 0 },
    });
  });

  test("a would-have-carried decision followed by a review that revises is recorded as a disagreement", async () => {
    const context = await approved(shadow);
    context.verdict = "REVISE";
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");

    const result = await context.review();

    expect(result.review.verdict).toBe("REVISE");
    const [record] = await listDecisionRecords(context.store, "add-search");
    expect(record).toMatchObject({
      wouldHaveActed: true,
      agreement: false,
      observed: { reviewVerdict: "REVISE", reviewRequiredChanges: 1 },
    });
  });

  test("a decision that abstained is observed but not compared", async () => {
    const context = await approved(shadow);
    context.answer = immaterial({ [REVIEW_TRIAGE_QUESTION_IDS.tasks]: noul(0.8) });
    context.verdict = "REVISE";
    await context.edit("proposal.md", "# Proposal\n\nAdd search and a new step.\n");

    await context.review();

    const [record] = await listDecisionRecords(context.store, "add-search");
    expect(record).toMatchObject({ wouldHaveActed: false, agreement: null, observed: { reviewVerdict: "REVISE" } });
  });

  test("a shadow approval retains its copy for the next edit", async () => {
    const context = await approved(shadow);
    await context.edit("proposal.md", "# Proposal\n\nAdd search to the palette.\n");
    const result = await context.review();
    expect(await context.snapshotFiles()).toContain(`${result.review.artifactDigest}.json`);
  });
});
