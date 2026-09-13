import { describe, expect, test } from "bun:test";
import {
  dispatchPlanningReview,
  runBrokeredPlanningReviewer,
  type PlanningReviewerRunner,
} from "../../src/review/planning-reviewer.ts";
import type { AgentRun } from "../../extensions/fusion-harness/modules/runtime.ts";
import { createReviewArtifact } from "../../src/review/review-artifact.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const review = createReviewArtifact({
  schemaVersion: 1,
  round: 1,
  reviewedAt: "2026-09-12T12:00:00.000Z",
  model: "openai/reviewer",
  artifactDigest: "a".repeat(64),
  requestedVerdict: "APPROVE",
  criticalFindings: [],
  requiredChanges: [],
  recommendations: [],
});

describe("planning reviewer dispatch", () => {
  test("prefers a different eligible model and records assignment evidence", async () => {
    const requests: Parameters<PlanningReviewerRunner>[0][] = [];
    const runner: PlanningReviewerRunner = async (request) => {
      requests.push(request);
      return { review: { ...review, model: request.model }, toolNames: ["muster_read", "muster_search"] };
    };

    const result = await dispatchPlanningReview({
      runId: "run-1",
      changeName: "add-search",
      cwd: "/repo",
      sessionsRoot: "/tmp/muster-sessions",
      author: { model: "openai/author", sessionId: "author-session" },
      candidates: [
        { model: "openai/author", available: true },
        { model: "anthropic/reviewer", available: true },
      ],
      prompt: "Review the planning artifacts.",
      runner,
    });

    expect(requests[0]).toMatchObject({
      model: "anthropic/reviewer",
      access: "read",
      tools: ["muster_read", "muster_search"],
    });
    expect(requests[0]?.sessionId).not.toBe("author-session");
    expect(result.assignment).toMatchObject({
      authorModel: "openai/author",
      reviewerModel: "anthropic/reviewer",
      differentModelPreferred: true,
      differentModelAssigned: true,
    });
  });

  test("creates a fresh isolated session for every review", async () => {
    const sessionIds: string[] = [];
    const runner: PlanningReviewerRunner = async (request) => {
      sessionIds.push(request.sessionId);
      return { review: { ...review, model: request.model }, toolNames: [] };
    };
    const options = {
      runId: "run-1",
      changeName: "add-search",
      cwd: "/repo",
      sessionsRoot: "/tmp/muster-sessions",
      author: { model: "openai/author", sessionId: "author-session" },
      candidates: [{ model: "openai/reviewer", available: true }],
      prompt: "Review the planning artifacts.",
      runner,
    };

    await dispatchPlanningReview(options);
    await dispatchPlanningReview(options);

    expect(sessionIds[0]).not.toBe(sessionIds[1]);
    expect(sessionIds).not.toContain("author-session");
  });

  test("fails closed when a reviewer reports use of a mutation tool", async () => {
    const runner: PlanningReviewerRunner = async (request) => ({
      review: { ...review, model: request.model },
      toolNames: ["muster_read", "write"],
    });

    await expect(dispatchPlanningReview({
      runId: "run-1",
      changeName: "add-search",
      cwd: "/repo",
      sessionsRoot: "/tmp/muster-sessions",
      author: { model: "openai/author", sessionId: "author-session" },
      candidates: [{ model: "openai/reviewer", available: true }],
      prompt: "Review the planning artifacts.",
      runner,
    })).rejects.toMatchObject({ code: "REVIEW_TOOL_DENIED" } as HarnessError);
  });

  test("runs a fresh reviewer through brokered read-only tools", async () => {
    const requests: Array<{ role: string; taskId: string }> = [];
    const result = await runBrokeredPlanningReviewer({
      runId: "run-1",
      changeName: "add-search",
      model: "openai/reviewer",
      cwd: "/repo",
      prompt: "Review planning.",
      sessionId: "review-session",
      sessionDir: "/tmp/review-session",
      access: "read",
      tools: ["muster_read", "muster_search"],
    }, async (request) => {
      requests.push({ role: request.role, taskId: request.taskId });
      request.run.status = "done";
      request.run.exitCode = 0;
      request.run.text = JSON.stringify(review);
      request.run.toolNames = ["muster_read"];
      return request.run as AgentRun;
    });

    expect(requests).toEqual([{ role: "reviewer", taskId: "planning.review" }]);
    expect(result.review).toEqual(review);
    expect(result.toolNames).toEqual(["muster_read"]);
  });
});