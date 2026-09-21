import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveChangeAction } from "../../src/controller/action-resolver.ts";
import {
  createChangeSnapshot,
  type ChangeSnapshotInput,
} from "../../src/controller/change-snapshot.ts";
import { reviewChange } from "../../src/controller/review.ts";
import { dispatchChangeCommand } from "../../src/change/change-command.ts";
import {
  discoverReviewedArtifacts,
  hashReviewedArtifacts,
} from "../../src/review/artifact-digest.ts";
import { createReviewArtifact, parseReviewArtifact } from "../../src/review/review-artifact.ts";
import { runBrokeredPlanningReviewer, type PlanningReviewerRunner } from "../../src/review/planning-reviewer.ts";
import type { AgentRun } from "../../src/agents/run-record.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { listDecisionRecords } from "../../src/judgment/audit.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { reviewExtractionLineQuestionId } from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";

const temporaryDirectories: string[] = [];
const observedAt = "2026-09-12T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function createChange(): Promise<{ repositoryRoot: string; changeRoot: string }> {
  const repositoryRoot = await mkdtemp(resolve(tmpdir(), "muster-review-command-"));
  temporaryDirectories.push(repositoryRoot);
  const changeRoot = resolve(repositoryRoot, "openspec", "changes", "add-search");
  await mkdir(resolve(changeRoot, "specs", "search"), { recursive: true });
  await Promise.all([
    writeFile(resolve(changeRoot, "proposal.md"), "# Proposal\n"),
    writeFile(resolve(changeRoot, "design.md"), "# Design\n"),
    writeFile(resolve(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] 1.1 Add search\n"),
    writeFile(resolve(changeRoot, "specs", "search", "spec.md"), "# Search\n"),
  ]);
  return { repositoryRoot, changeRoot };
}

function snapshotInput(
  artifactDigest: string,
  review: ReturnType<typeof createReviewArtifact>,
): ChangeSnapshotInput {
  return {
    capturedAt: observedAt,
    openSpec: {
      observedAt,
      changeName: "add-search",
      planningComplete: true,
      tasks: { "1.1": false },
      artifactDigest,
    },
    repository: {
      observedAt,
      repositoryId: "repo-1",
      commonDirectory: "/repo/.git",
      worktree: "/repo",
      head: "a".repeat(40),
      indexDigest: "index",
      diffDigest: "diff",
      sourceDigest: "source",
    },
    runtime: null,
    review: { observedAt, artifact: review },
    validation: null,
    pendingCheckpointIds: [],
  };
}

describe("change review command", () => {
  test("dispatches a fresh reviewer and durably persists the current approval", async () => {
    const { repositoryRoot, changeRoot } = await createChange();
    const sessionIds: string[] = [];
    const prompts: string[] = [];
    const runner: PlanningReviewerRunner = async (request) => {
      sessionIds.push(request.sessionId);
      prompts.push(request.prompt);
      return {
        review: createReviewArtifact({
          schemaVersion: 1,
          round: 99,
          reviewedAt: observedAt,
          model: request.model,
          artifactDigest: "f".repeat(64),
          requestedVerdict: "APPROVE",
          criticalFindings: [],
          requiredChanges: [],
          recommendations: [],
        }),
        toolNames: ["muster_read", "muster_search"],
      };
    };
    const notifications: string[] = [];

    await dispatchChangeCommand("review add-search", {
      ui: { notify: (message) => notifications.push(message) },
    }, {
      resolveChangeName: async (explicit) => explicit ?? null,
      loadSnapshot: async () => createChangeSnapshot(snapshotInput(
        "0".repeat(64),
        createReviewArtifact({
          schemaVersion: 1,
          round: 1,
          reviewedAt: observedAt,
          model: "openai/old-reviewer",
          artifactDigest: "1".repeat(64),
          requestedVerdict: "APPROVE",
          criticalFindings: [],
          requiredChanges: [],
          recommendations: [],
        }),
      )),
      handlers: {
        review: async (command, context) => {
          const result = await reviewChange({
            repositoryRoot,
            changeRoot,
            changeName: command.changeName!,
            runId: "run-1",
            sessionsRoot: resolve(repositoryRoot, ".fusion", "sessions"),
            author: { model: "openai/author", sessionId: "author-session" },
            candidates: [{ model: "openai/reviewer", available: true }],
            runner,
          }, { now: () => new Date(observedAt) });
          context.ui.notify(`Review: ${result.review.verdict}. Next: /change ${result.nextAction} add-search`);
        },
      },
    });

    const persisted = parseReviewArtifact(
      await readFile(resolve(changeRoot, "review.md"), "utf8"),
      resolve(changeRoot, "review.md"),
    );
    const currentDigest = await hashReviewedArtifacts(
      await discoverReviewedArtifacts(repositoryRoot, changeRoot),
    );
    expect(persisted).toMatchObject({
      round: 1,
      verdict: "APPROVE",
      artifactDigest: currentDigest,
      model: "openai/reviewer",
    });
    expect(sessionIds).toHaveLength(1);
    expect(sessionIds).not.toContain("author-session");
    expect(prompts[0]).toContain("openspec/changes/add-search/specs/search/spec.md");
    expect(notifications).toEqual(["Review: APPROVE. Next: /change implement add-search"]);
  });

  test("persists revise loops and blocks implementation until the approval is current", async () => {
    const { repositoryRoot, changeRoot } = await createChange();
    const sessionIds: string[] = [];
    let requiredChanges = ["Add the missing failure scenario."];
    const runner: PlanningReviewerRunner = async (request) => {
      sessionIds.push(request.sessionId);
      return {
        review: createReviewArtifact({
          schemaVersion: 1,
          round: 1,
          reviewedAt: observedAt,
          model: request.model,
          artifactDigest: "f".repeat(64),
          requestedVerdict: requiredChanges.length > 0 ? "REVISE" : "APPROVE",
          criticalFindings: [],
          requiredChanges,
          recommendations: [],
        }),
        toolNames: ["muster_read"],
      };
    };
    const input = {
      repositoryRoot,
      changeRoot,
      changeName: "add-search",
      runId: "run-1",
      sessionsRoot: resolve(repositoryRoot, ".fusion", "sessions"),
      author: { model: "openai/author", sessionId: "author-session" },
      candidates: [{ model: "openai/reviewer", available: true }],
      runner,
    } as const;

    const revised = await reviewChange(input, { now: () => new Date(observedAt) });
    expect(revised.review).toMatchObject({ round: 1, verdict: "REVISE" });
    expect(revised.nextAction).toBe("refine");
    let digest = await hashReviewedArtifacts(await discoverReviewedArtifacts(repositoryRoot, changeRoot));
    let snapshot = createChangeSnapshot(snapshotInput(digest, revised.review));
    expect(snapshot.lifecycle).toBe("REVIEW_REQUIRED");
    expect(resolveChangeAction("implement", snapshot)).toMatchObject({
      allowed: false,
      nextAction: "review",
    });

    await writeFile(resolve(changeRoot, "design.md"), "# Design\n\nFailure behavior added.\n");
    requiredChanges = [];
    const approved = await reviewChange(input, { now: () => new Date(observedAt) });
    expect(approved.review).toMatchObject({ round: 2, verdict: "APPROVE" });
    expect(approved.nextAction).toBe("implement");
    expect(sessionIds[0]).not.toBe(sessionIds[1]);

    digest = await hashReviewedArtifacts(await discoverReviewedArtifacts(repositoryRoot, changeRoot));
    snapshot = createChangeSnapshot(snapshotInput(digest, approved.review));
    expect(snapshot.lifecycle).toBe("READY");
    expect(resolveChangeAction("implement", snapshot).allowed).toBe(true);

    await writeFile(resolve(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] 1.1 Add safer search\n");
    digest = await hashReviewedArtifacts(await discoverReviewedArtifacts(repositoryRoot, changeRoot));
    snapshot = createChangeSnapshot(snapshotInput(digest, approved.review));
    expect(snapshot.freshness.review).toBe("stale");
    expect(resolveChangeAction("implement", snapshot)).toMatchObject({
      allowed: false,
      nextAction: "review",
    });
  });
});
const PROSE = [
  "Overall the plan needs work.",
  "",
  "## Required changes",
  "- The migration has no rollback.",
  "",
  "## Recommendations",
  "- Consider a shorter task list.",
].join("\n");

function extractionAnswers(verdict: string, kinds: readonly string[]): JudgmentAnswers {
  const answers: Record<string, JudgmentAnswers[string]> = {
    verdict: { type: "choice", choice: verdict, probabilities: { [verdict]: 0.95 }, confidence: 0.95 },
  };
  kinds.forEach((kind, position) => {
    answers[reviewExtractionLineQuestionId(position + 1)] = {
      type: "choice",
      choice: kind,
      probabilities: { [kind]: 0.95 },
      confidence: 0.95,
    };
  });
  return answers;
}

/** Runs the real reviewer runner over a reviewer that only ever writes prose. */
async function reviewProse(options: {
  answers: JudgmentAnswers;
  toolNames?: readonly string[];
  judgment?: "enforce" | "absent";
}) {
  const { repositoryRoot, changeRoot } = await createChange();
  const store = new AtomicJsonStore(resolve(repositoryRoot, ".store"));
  const runtime = createJudgmentRuntime({
    env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce" },
    store,
    client: {
      async request() {
        return {
          available: true,
          answers: options.answers,
          model: "jev-1.13.0",
          inputTokens: 100,
          outputTokens: 0,
          durationMs: 1,
        };
      },
    },
  });
  let childCalls = 0;
  const runner: PlanningReviewerRunner = (request) => runBrokeredPlanningReviewer(request, async (child) => {
    childCalls += 1;
    child.run.status = "done";
    child.run.exitCode = 0;
    child.run.text = PROSE;
    child.run.toolNames = [...(options.toolNames ?? ["muster_read"])];
    return child.run as AgentRun;
  });
  const input = {
    repositoryRoot,
    changeRoot,
    changeName: "add-search",
    runId: "run-1",
    sessionsRoot: resolve(repositoryRoot, ".fusion", "sessions"),
    author: { model: "openai/author", sessionId: "author-session" },
    candidates: [{ model: "openai/reviewer", available: true }],
    runner,
    ...(options.judgment === "absent" ? {} : { judgment: { runtime, store } }),
  };
  const outcome = await reviewChange(input, { now: () => new Date(observedAt) }).then(
    (result) => ({ result, error: undefined as unknown }),
    (error: unknown) => ({ result: undefined, error }),
  );
  return { ...outcome, changeRoot, repositoryRoot, store, childCalls: () => childCalls };
}

describe("change review with extraction", () => {
  test("persists an accepted extraction with its mark, and the mark names the decision record", async () => {
    const run = await reviewProse({ answers: extractionAnswers("revise", ["not_a_finding", "required", "recommendation"]) });

    expect(run.error).toBeUndefined();
    expect(run.childCalls()).toBe(1);
    const [record] = await listDecisionRecords(run.store, "add-search");
    const path = resolve(run.changeRoot, "review.md");
    const markdown = await readFile(path, "utf8");
    const persisted = parseReviewArtifact(markdown, path);
    expect(persisted.extraction).toEqual({ recordId: record!.recordId });
    expect(markdown).toContain(`- Extraction record: \`${record!.recordId}\``);
    expect(persisted).toMatchObject({
      verdict: "REVISE",
      requiredChanges: ["The migration has no rollback."],
      recommendations: ["Consider a shorter task list."],
      criticalFindings: [],
      model: "openai/reviewer",
    });
    expect(run.result?.nextAction).toBe("refine");
    expect(run.result?.review.extraction).toEqual({ recordId: record!.recordId });
  });

  test("the persisted review is bound to the controller's digest and passes the same lifecycle checks", async () => {
    const run = await reviewProse({ answers: extractionAnswers("revise", ["not_a_finding", "required", "recommendation"]) });

    const digest = await hashReviewedArtifacts(await discoverReviewedArtifacts(run.repositoryRoot, run.changeRoot));
    expect(run.result?.review.artifactDigest).toBe(digest);
    const snapshot = createChangeSnapshot(snapshotInput(digest, run.result!.review));
    expect(snapshot.lifecycle).toBe("REVIEW_REQUIRED");
    expect(snapshot.freshness.review).toBe("current");
    expect(resolveChangeAction("implement", snapshot)).toMatchObject({ allowed: false, nextAction: "review" });
  });

  test("an accepted approval is persisted as an approval with its mark", async () => {
    const run = await reviewProse({ answers: extractionAnswers("approve", ["not_a_finding", "recommendation", "recommendation"]) });

    expect(run.result?.review).toMatchObject({ verdict: "APPROVE", requiredChanges: [] });
    expect(run.result?.review.extraction).toBeDefined();
    expect(run.result?.nextAction).toBe("implement");
  });

  test("the reviewer's tool use is still audited: a non-read-only tool fails the review and persists nothing", async () => {
    const run = await reviewProse({
      answers: extractionAnswers("revise", ["not_a_finding", "required", "recommendation"]),
      toolNames: ["muster_read", "write"],
    });

    expect(run.error).toMatchObject({ code: "REVIEW_TOOL_DENIED" });
    await expect(readFile(resolve(run.changeRoot, "review.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("without judgment the same prose fails the review and leaves no review artifact", async () => {
    const run = await reviewProse({
      answers: extractionAnswers("revise", ["not_a_finding", "required", "recommendation"]),
      judgment: "absent",
    });

    expect(run.error).toMatchObject({ code: "REVIEW_ARTIFACT_INVALID" });
    expect(run.childCalls()).toBe(2);
    await expect(readFile(resolve(run.changeRoot, "review.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an unaccepted extraction persists nothing marked", async () => {
    const run = await reviewProse({ answers: extractionAnswers("unclear", ["not_a_finding", "not_a_finding", "not_a_finding"]) });

    expect(run.error).toMatchObject({ code: "REVIEW_ARTIFACT_INVALID" });
    expect(run.childCalls()).toBe(2);
  });
});

describe("change review with task quality notes", () => {
  const promptFor = async (taskQualityNotes?: readonly string[]) => {
    const { repositoryRoot, changeRoot } = await createChange();
    const prompts: string[] = [];
    const runner: PlanningReviewerRunner = async (request) => {
      prompts.push(request.prompt);
      return {
        review: { verdict: "APPROVE", criticalFindings: [], requiredChanges: [], recommendations: [] },
        toolNames: ["muster_read"],
      };
    };
    const result = await reviewChange({
      repositoryRoot,
      changeRoot,
      changeName: "add-search",
      runId: "run-1",
      sessionsRoot: resolve(repositoryRoot, ".fusion", "sessions"),
      author: { model: "openai/author", sessionId: "author-session" },
      candidates: [{ model: "openai/reviewer", available: true }],
      runner,
      ...(taskQualityNotes ? { taskQualityNotes } : {}),
    }, { now: () => new Date(observedAt) });
    return { prompt: prompts[0]!, result, changeRoot };
  };

  test("current findings appear in the prompt marked as unverified", async () => {
    const note = "Task 1.1: its write scopes may not cover every file its description requires changing (probability 0.90).";
    const { prompt } = await promptFor([note]);
    expect(prompt).toContain("Unverified automated notes about the task list");
    expect(prompt).toContain("Confirm or dismiss each");
    expect(prompt).toContain(`- ${note}`);
    expect(prompt.indexOf("Unverified")).toBeGreaterThan(prompt.indexOf("Return APPROVE only when"));
  });

  test("without findings the prompt is exactly what it is without the input", async () => {
    const plain = await promptFor();
    expect((await promptFor([])).prompt).toBe(plain.prompt);
    expect(plain.prompt).not.toContain("Unverified");
  });

  test("the verdict and the review artifact come only from the reviewer's output", async () => {
    const { result, changeRoot } = await promptFor(["Task 1.1: it may bundle more than one coherent unit of work (probability 0.95)."]);
    expect(result.review).toMatchObject({
      verdict: "APPROVE",
      criticalFindings: [],
      requiredChanges: [],
      recommendations: [],
    });
    const persisted = await readFile(resolve(changeRoot, "review.md"), "utf8");
    expect(persisted).not.toContain("bundle more than one");
    expect(persisted).not.toContain("Unverified");
  });
});
