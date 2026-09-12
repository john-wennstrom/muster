import { describe, expect, test } from "bun:test";
import {
  dispatchPlanningReview,
  type PlanningReviewerRunner,
} from "../../src/review/planning-reviewer.ts";
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
      return { review: { ...review, model: request.model }, toolNames: ["read", "grep"] };
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
      tools: ["read", "grep", "find", "ls"],
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
      toolNames: ["read", "write"],
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
});