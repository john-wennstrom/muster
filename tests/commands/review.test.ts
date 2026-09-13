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
import { dispatchChangeCommand } from "../../src/extension/change-command.ts";
import {
  discoverReviewedArtifacts,
  hashReviewedArtifacts,
} from "../../src/review/artifact-digest.ts";
import { createReviewArtifact, parseReviewArtifact } from "../../src/review/review-artifact.ts";
import type { PlanningReviewerRunner } from "../../src/review/planning-reviewer.ts";

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
    expect(revised.nextAction).toBe("review");
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