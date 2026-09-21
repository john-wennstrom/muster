import { describe, expect, test } from "bun:test";
import {
  dispatchPlanningReview,
  runBrokeredPlanningReviewer,
  type PlanningReviewerRunner,
} from "../../src/review/planning-reviewer.ts";
import type { AgentRun } from "../../src/agents/run-record.ts";
import { createReviewArtifact } from "../../src/review/review-artifact.ts";
import { HarnessError } from "../../src/shared/errors.ts";
import type {
} from "../../src/judgment/client.ts";

const reviewSubmission = {
  verdict: "APPROVE" as const,
  criticalFindings: [] as string[],
  requiredChanges: [] as string[],
  recommendations: [] as string[],
};

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
  test("accepts configured read tools for the selected slot", async () => {
    const result = await dispatchPlanningReview({
      runId: "run-1", changeName: "add-search", cwd: "/repo", sessionsRoot: "/tmp/muster-sessions",
      author: { model: "openai/author" },
      candidates: [{ model: "openai/reviewer", available: true, readTools: ["read", "grep", "find", "ls", "symbols"] }],
      prompt: "Review planning.",
      runner: async (request) => {
        expect(request.tools).toContain("symbols");
        return { review, toolNames: ["find", "symbols"] };
      },
    });
    expect(result.assignment.tools).toContain("symbols");
  });

  test("prefers a different eligible model and records assignment evidence", async () => {
    const requests: Parameters<PlanningReviewerRunner>[0][] = [];
    const runner: PlanningReviewerRunner = async (request) => {
      requests.push(request);
      return { review: { ...review, model: request.model }, toolNames: ["read", "grep", "find", "ls"] };
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

  test("runs a fresh reviewer with standard read-only tools", async () => {
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
      tools: ["read", "grep", "find", "ls"],
    }, async (request) => {
      requests.push({ role: request.role, taskId: request.taskId });
      request.run.status = "done";
      request.run.exitCode = 0;
      request.run.text = JSON.stringify(reviewSubmission);
      request.run.toolNames = ["muster_read"];
      return request.run as AgentRun;
    });

    expect(requests).toEqual([{ role: "reviewer", taskId: "planning.review" }]);
    expect(result.review).toEqual(reviewSubmission);
    expect(result.toolNames).toEqual(["muster_read"]);
  });

  test("retries once with a corrective prompt when the reviewer returns no JSON", async () => {
    const prompts: string[] = [];
    const result = await runBrokeredPlanningReviewer({
      runId: "run-1",
      changeName: "add-search",
      model: "openai/reviewer",
      cwd: "/repo",
      prompt: "Review planning.",
      sessionId: "review-session",
      sessionDir: "/tmp/review-session",
      access: "read",
      tools: ["read", "grep", "find", "ls"],
    }, async (request) => {
      prompts.push(request.prompt);
      request.run.status = "done";
      request.run.exitCode = 0;
      request.run.text = prompts.length === 1 ? "Let me think about this some more..." : JSON.stringify(reviewSubmission);
      request.run.toolNames = ["muster_read"];
      return request.run as AgentRun;
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your previous response was rejected");
    expect(result.review).toEqual(reviewSubmission);
  });

  test("tolerates extra fields the model has no business inventing (round, digest, its own model id)", async () => {
    const result = await runBrokeredPlanningReviewer({
      runId: "run-1",
      changeName: "add-search",
      model: "openai/reviewer",
      cwd: "/repo",
      prompt: "Review planning.",
      sessionId: "review-session",
      sessionDir: "/tmp/review-session",
      access: "read",
      tools: ["read", "grep", "find", "ls"],
    }, async (request) => {
      request.run.status = "done";
      request.run.exitCode = 0;
      request.run.text = JSON.stringify({ ...review, summary: "looks fine" });
      request.run.toolNames = [];
      return request.run as AgentRun;
    });

    expect(result.review).toEqual(reviewSubmission);
  });

  test("rejects a well-formed but wrong-shaped review (e.g. summary/findings instead of the required fields)", async () => {
    await expect(runBrokeredPlanningReviewer({
      runId: "run-1",
      changeName: "add-search",
      model: "openai/reviewer",
      cwd: "/repo",
      prompt: "Review planning.",
      sessionId: "review-session",
      sessionDir: "/tmp/review-session",
      access: "read",
      tools: ["read", "grep", "find", "ls"],
    }, async (request) => {
      request.run.status = "done";
      request.run.exitCode = 0;
      request.run.text = JSON.stringify({
        verdict: "APPROVE",
        summary: "Looks good.",
        findings: [{ severity: "info", location: "design.md", message: "minor nit" }],
      });
      request.run.toolNames = [];
      return request.run as AgentRun;
    })).rejects.toMatchObject({ code: "REVIEW_ARTIFACT_INVALID" } as HarnessError);
  });

  test("fails closed after exhausting retries on an invalid reviewer response", async () => {
    let calls = 0;
    await expect(runBrokeredPlanningReviewer({
      runId: "run-1",
      changeName: "add-search",
      model: "openai/reviewer",
      cwd: "/repo",
      prompt: "Review planning.",
      sessionId: "review-session",
      sessionDir: "/tmp/review-session",
      access: "read",
      tools: ["read", "grep", "find", "ls"],
    }, async (request) => {
      calls += 1;
      request.run.status = "done";
      request.run.exitCode = 0;
      request.run.text = "not json";
      request.run.toolNames = [];
      return request.run as AgentRun;
    })).rejects.toMatchObject({ code: "REVIEW_ARTIFACT_INVALID" } as HarnessError);
    expect(calls).toBe(2);
  });
});
