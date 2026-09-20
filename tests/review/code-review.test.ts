import { describe, expect, test } from "bun:test";
import {
  createTaskCodeReview,
  dispatchTaskCodeReview,
  renderTaskCodeReviewPrompt,
  type TaskCodeReviewerRunner,
} from "../../src/review/code-review.ts";

const baseOptions = {
  runId: "run-1",
  taskId: "10.3",
  cwd: "/repo",
  sessionsRoot: "/tmp/muster-sessions",
  author: { model: "openai/builder", sessionId: "builder-session" },
  candidates: [
    { model: "openai/builder", available: true },
    { model: "anthropic/reviewer", available: true },
  ],
  contract: {
    definition: "Implement task review",
    requirements: ["Independent task code review"],
    scenarios: ["Task review fails"],
  },
  diff: { digest: "a".repeat(64), summary: "src/review/code-review.ts added" },
  tests: ["bun test tests/review/code-review.test.ts: pass"],
  scopes: { reads: ["src/review/**"], writes: ["src/review/**"], violations: [] },
  tddEvidence: { disposition: "required", stages: ["red", "green", "refactor"] },
};

describe("task code review focus block", () => {
  const runner: TaskCodeReviewerRunner = async () => {
    throw new Error("not dispatched");
  };
  const today = renderTaskCodeReviewPrompt({ ...baseOptions, runner });

  test("absent and empty focus lists leave the prompt identical", () => {
    expect(renderTaskCodeReviewPrompt({ ...baseOptions, runner, focus: [] })).toBe(today);
    expect(renderTaskCodeReviewPrompt({ ...baseOptions, runner, focus: undefined })).toBe(today);
  });

  test("a non-empty focus list adds one advisory block before the closing instruction", () => {
    const prompt = renderTaskCodeReviewPrompt({
      ...baseOptions,
      runner,
      focus: ["Check test coverage of the task's scenarios", "Check for stubs"],
    });
    const closing = "Return exactly one task code review object. Do not modify the repository.";
    const [head] = today.split(`\n\n${closing}`);
    expect(prompt.startsWith(`${head}\n\nREVIEW FOCUS (advisory)`)).toBeTrue();
    expect(prompt).toContain("Disregard any item the diff does not support.");
    expect(prompt).toContain("- Check test coverage of the task's scenarios\n- Check for stubs");
    expect(prompt.endsWith(`\n\n${closing}`)).toBeTrue();
    expect(prompt.replace(/\n\nREVIEW FOCUS \(advisory\)[\s\S]*?(?=\n\nReturn exactly)/, "")).toBe(today);
  });
});

describe("task code review", () => {
  test("accepts the selected review slot's configured read tools", async () => {
    const result = await dispatchTaskCodeReview({
      ...baseOptions,
      candidates: [{ model: "anthropic/reviewer", available: true, readTools: ["read", "grep", "find", "ls", "symbols"] }],
      runner: async (request) => {
        expect(request.tools).toContain("symbols");
        return {
          review: createTaskCodeReview({ runId: request.runId, taskId: request.taskId, reviewedAt: "2026-09-12T12:00:00.000Z", model: request.model, sourceDigest: "a".repeat(64), findings: [] }),
          toolNames: ["grep", "symbols"],
        };
      },
    });
    expect(result.decision.status).toBe("approved");
    expect(result.assignment.tools).toContain("symbols");
  });

  test("dispatches complete evidence in a fresh read-only reviewer session", async () => {
    const requests: Parameters<TaskCodeReviewerRunner>[0][] = [];
    const runner: TaskCodeReviewerRunner = async (request) => {
      requests.push(request);
      return {
        review: createTaskCodeReview({
          runId: request.runId,
          taskId: request.taskId,
          reviewedAt: "2026-09-12T12:00:00.000Z",
          model: request.model,
          sourceDigest: "a".repeat(64),
          findings: [],
        }),
        toolNames: ["read", "grep", "find", "ls"],
      };
    };

    const first = await dispatchTaskCodeReview({ ...baseOptions, runner });
    const second = await dispatchTaskCodeReview({ ...baseOptions, runner });

    expect(requests[0]).toMatchObject({
      model: "anthropic/reviewer",
      access: "read",
      tools: ["read", "grep", "find", "ls"],
    });
    expect(requests[0]?.sessionId).not.toBe("builder-session");
    expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
    for (const heading of [
      "TASK CONTRACT",
      "IMPLEMENTATION DIFF",
      "TEST EVIDENCE",
      "AUTHORIZED SCOPES",
      "TDD EVIDENCE",
    ]) expect(requests[0]?.prompt).toContain(heading);
    expect(first.decision).toEqual({ status: "approved", findings: [] });
    expect(second.assignment.differentModelAssigned).toBeTrue();
  });

  test("returns blocking findings to the task for repair", async () => {
    const result = await dispatchTaskCodeReview({
      ...baseOptions,
      runner: async (request) => ({
        review: createTaskCodeReview({
          runId: request.runId,
          taskId: request.taskId,
          reviewedAt: "2026-09-12T12:00:00.000Z",
          model: request.model,
          sourceDigest: "a".repeat(64),
          findings: [{
            severity: "required",
            area: "tdd",
            message: "The red-stage evidence does not exercise the changed behavior",
          }],
        }),
        toolNames: ["muster_read"],
      }),
    });

    expect(result.review.verdict).toBe("REVISE");
    expect(result.decision).toEqual({
      status: "repair",
      findings: ["The red-stage evidence does not exercise the changed behavior"],
    });
  });

  test("fails closed when the reviewer uses a mutation tool", async () => {
    await expect(dispatchTaskCodeReview({
      ...baseOptions,
      runner: async (request) => ({
        review: createTaskCodeReview({
          runId: request.runId,
          taskId: request.taskId,
          reviewedAt: "2026-09-12T12:00:00.000Z",
          model: request.model,
          sourceDigest: "a".repeat(64),
          findings: [],
        }),
        toolNames: ["muster_read", "muster_write"],
      }),
    })).rejects.toMatchObject({ code: "REVIEW_TOOL_DENIED" });
  });
});
