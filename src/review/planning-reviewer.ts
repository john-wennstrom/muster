import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { newRun, READONLY_TOOLS, type AgentRun } from "../../extensions/fusion-harness/modules/runtime.ts";
import {
  runLegacyReadOnlyChild,
  type RunLegacyReadOnlyChildOptions,
} from "../agents/legacy-adapter.ts";
import { HarnessError } from "../shared/errors.ts";
import {
  planningReviewSubmissionSchema,
  type PlanningReviewSubmission,
} from "./review-artifact.ts";

const REVIEW_TOOLS = READONLY_TOOLS.split(",");

// A high-thinking, read-only pass over the target repo — same order of
// magnitude as planning/exploration (30 min), not the 2 min budget this
// previously shared with the much narrower task-step code-review call.
const PLANNING_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

export interface ReviewModelCandidate {
  model: string;
  available: boolean;
  readTools?: readonly string[];
}

export interface PlanningReviewerRequest {
  runId: string;
  changeName: string;
  model: string;
  cwd: string;
  prompt: string;
  sessionId: string;
  sessionDir: string;
  access: "read";
  tools: readonly string[];
  signal?: AbortSignal;
}

export interface PlanningReviewerResponse {
  review: PlanningReviewSubmission;
  toolNames: readonly string[];
}

export type PlanningReviewerRunner = (
  request: PlanningReviewerRequest,
) => Promise<PlanningReviewerResponse>;

export interface PlanningReviewDispatchOptions {
  runId: string;
  changeName: string;
  cwd: string;
  sessionsRoot: string;
  author: {
    model: string;
    sessionId?: string;
  };
  candidates: readonly ReviewModelCandidate[];
  prompt: string;
  runner: PlanningReviewerRunner;
  signal?: AbortSignal;
}

export interface PlanningReviewAssignment {
  runId: string;
  changeName: string;
  authorModel: string;
  reviewerModel: string;
  reviewerSessionId: string;
  differentModelPreferred: boolean;
  differentModelAssigned: boolean;
  access: "read";
  tools: readonly string[];
}

export interface PlanningReviewDispatchResult {
  review: PlanningReviewSubmission;
  assignment: PlanningReviewAssignment;
}

export type PlanningReviewerChildRunner = (
  options: RunLegacyReadOnlyChildOptions,
) => Promise<AgentRun>;

// Reviewers sometimes burn their whole turn on reasoning and never emit the
// JSON object, or wrap it in a fence despite being told not to. Both are
// recoverable by nudging the same session to stop and answer, so a bad
// response gets one corrective retry before failing the review outright.
const MAX_REVIEW_ATTEMPTS = 2;

function tryParseReviewerJson(text: string): { success: true; value: unknown } | { success: false; error: string } {
  try {
    return { success: true, value: JSON.parse(text) };
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function runBrokeredPlanningReviewer(
  request: PlanningReviewerRequest,
  childRunner: PlanningReviewerChildRunner = runLegacyReadOnlyChild,
): Promise<PlanningReviewerResponse> {
  let correction: string | undefined;
  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
    const run = newRun("REVIEWER", request.model);
    await childRunner({
      run,
      prompt: [
        request.prompt,
        [
          "Return exactly one JSON object with only these fields — no markdown or code fence, no other fields, nothing before or after it:",
          '{"verdict":"APPROVE"|"REVISE","criticalFindings":string[],"requiredChanges":string[],"recommendations":string[]}',
          "criticalFindings, requiredChanges, and recommendations are arrays of single-line strings (use [] when there are none). verdict must be REVISE if either criticalFindings or requiredChanges is non-empty; otherwise APPROVE.",
        ].join("\n"),
        correction,
      ].filter((line): line is string => Boolean(line)).join("\n\n"),
      role: "reviewer",
      runId: request.runId,
      childId: request.sessionId,
      taskId: "planning.review",
      description: `Review planning for ${request.changeName}`,
      assignee: "reviewer",
      thinking: "high",
      sessionDir: request.sessionDir,
      sessionId: request.sessionId,
      continueTaskSession: true,
      cwd: request.cwd,
      timeoutMs: PLANNING_REVIEW_TIMEOUT_MS,
      signal: request.signal,
    });
    if (run.status !== "done") {
      throw new HarnessError(
        "REVIEW_ARTIFACT_INVALID",
        `Planning reviewer failed with status ${run.status}`,
        { runId: request.runId, exitCode: run.exitCode, error: run.errorMessage },
      );
    }
    const parsedJson = tryParseReviewerJson(run.text);
    const parsed = parsedJson.success
      ? planningReviewSubmissionSchema.safeParse(parsedJson.value)
      : undefined;
    if (parsed?.success) return { review: parsed.data, toolNames: run.toolNames };

    const reason = !parsedJson.success
      ? `it was not valid JSON (${parsedJson.error})`
      : `it did not match the required shape (${parsed!.error.issues.map((issue) => issue.message).join("; ")})`;
    if (attempt >= MAX_REVIEW_ATTEMPTS) {
      throw new HarnessError(
        "REVIEW_ARTIFACT_INVALID",
        !parsedJson.success
          ? "Planning reviewer did not return one JSON review object"
          : "Planning reviewer returned an incompatible review object",
        !parsedJson.success ? {} : { issues: parsed!.error.issues },
      );
    }
    correction = `Your previous response was rejected: ${reason}. Stop any further analysis and respond now with only the JSON object — no reasoning, no prose, no markdown fence, nothing before or after it.`;
  }
  throw new HarnessError("REVIEW_ARTIFACT_INVALID", "Planning reviewer did not return one JSON review object", {});
}

function selectReviewer(
  candidates: readonly ReviewModelCandidate[],
  authorModel: string,
): { candidate: ReviewModelCandidate; differentModelAvailable: boolean } {
  const available = candidates.filter((candidate) => candidate.available);
  const different = available.find((candidate) => candidate.model !== authorModel);
  const candidate = different ?? available[0];
  if (!candidate) {
    throw new HarnessError(
      "REVIEW_MODEL_UNAVAILABLE",
      "No eligible planning review model is available",
      { authorModel, candidates },
    );
  }
  return { candidate, differentModelAvailable: different !== undefined };
}

export async function dispatchPlanningReview(
  options: PlanningReviewDispatchOptions,
): Promise<PlanningReviewDispatchResult> {
  const { candidate, differentModelAvailable } = selectReviewer(
    options.candidates,
    options.author.model,
  );
  const sessionId = randomUUID();
  const tools = candidate.readTools ?? REVIEW_TOOLS;
  const reviewToolSet = new Set([...tools, "muster_read", "muster_search"]);
  if (sessionId === options.author.sessionId) {
    throw new HarnessError(
      "REVIEW_TOOL_DENIED",
      "Planning reviewer session must not reuse the author session",
      { sessionId },
    );
  }

  const request: PlanningReviewerRequest = {
    runId: options.runId,
    changeName: options.changeName,
    model: candidate.model,
    cwd: options.cwd,
    prompt: options.prompt,
    sessionId,
    sessionDir: resolve(options.sessionsRoot, "planning-review", sessionId),
    access: "read",
    tools,
    signal: options.signal,
  };
  const response = await options.runner(request);

  const deniedTools = [...new Set(response.toolNames.filter((tool) => !reviewToolSet.has(tool)))];
  if (deniedTools.length > 0) {
    throw new HarnessError(
      "REVIEW_TOOL_DENIED",
      `Planning reviewer attempted non-read-only tools: ${deniedTools.join(", ")}`,
      {
        runId: options.runId,
        changeName: options.changeName,
        sessionId,
        deniedTools,
      },
    );
  }

  const parsedReview = planningReviewSubmissionSchema.safeParse(response.review);
  if (!parsedReview.success) {
    throw new HarnessError(
      "REVIEW_ARTIFACT_INVALID",
      "Planning reviewer returned invalid review evidence",
      { runId: options.runId, issues: parsedReview.error.issues },
    );
  }

  return {
    review: parsedReview.data,
    assignment: {
      runId: options.runId,
      changeName: options.changeName,
      authorModel: options.author.model,
      reviewerModel: candidate.model,
      reviewerSessionId: sessionId,
      differentModelPreferred: differentModelAvailable,
      differentModelAssigned: candidate.model !== options.author.model,
      access: "read",
      tools,
    },
  };
}
