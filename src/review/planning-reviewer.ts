import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { READONLY_TOOLS } from "../agents/child-runtime.ts";
import { newRun, type AgentRun } from "../agents/run-record.ts";
import { runAgent, type ReadAgentRunner } from "../agents/spawn.ts";
import { HarnessError } from "../shared/errors.ts";
import {
  planningReviewSubmissionSchema,
  type PlanningReviewSubmission,
  type ReviewExtractionMark,
} from "./review-artifact.ts";
import {
  attemptReviewExtraction,
  reconcileReviewExtraction,
  type PlanningReviewJudgment,
} from "./review-extraction.ts";
import { renderPrompt, type RenderedPrompt } from "../prompts/render.ts";

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
  /** Absent means judgment plays no part: no request, no record, no change to any retry. */
  judgment?: PlanningReviewJudgment;
}

export interface PlanningReviewerResponse {
  review: PlanningReviewSubmission;
  toolNames: readonly string[];
  /** Present only when the review was recovered from the reviewer's prose, not parsed from it. */
  extraction?: ReviewExtractionMark;
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
  judgment?: PlanningReviewJudgment;
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
  extraction?: ReviewExtractionMark;
}

export type PlanningReviewerChildRunner = ReadAgentRunner;

// Reviewers sometimes burn their whole turn on reasoning and never emit the
// JSON object, or wrap it in a fence despite being told not to. Both are
// recoverable by nudging the same session to stop and answer, so a bad
// response gets one corrective retry before failing the review outright. A response
// that is not JSON at all is first offered to review extraction, which can recover the
// review from the reviewer's own prose without spending the retry.
const MAX_REVIEW_ATTEMPTS = 2;

function tryParseReviewerJson(text: string): { success: true; value: unknown } | { success: false; error: string } {
  try {
    return { success: true, value: JSON.parse(text) };
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** What the planning reviewer is asked, with the output contract and any correction after a rejected reply. */
export function planningReviewerPrompt(reviewRequest: string, correction?: string): RenderedPrompt {
  return renderPrompt("planning-reviewer", {
    REVIEW_REQUEST: reviewRequest,
    CORRECTION_BLOCK: correction ?? "",
  });
}

export function planningReviewCorrection(reason: string): string {
  return renderPrompt("planning-review-correction", { REASON: reason });
}

export async function runBrokeredPlanningReviewer(
  request: PlanningReviewerRequest,
  childRunner: PlanningReviewerChildRunner = runAgent,
): Promise<PlanningReviewerResponse> {
  let correction: string | undefined;
  // The record of an extraction that did not replace the retry, to compare with the retry's result.
  let unactedRecordId: string | null = null;
  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
    const run = newRun("REVIEWER", request.model);
    await childRunner({
      access: "read",
      run,
      prompt: planningReviewerPrompt(request.prompt, correction),
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
    if (parsed?.success) {
      if (request.judgment) {
        await reconcileReviewExtraction(request.judgment, request.changeName, unactedRecordId, parsed.data);
      }
      return { review: parsed.data, toolNames: run.toolNames };
    }

    // Only a response that is not JSON at all is extracted. JSON that fails the schema is a
    // reviewer contradicting itself, which no classification of its lines can resolve.
    if (!parsedJson.success && request.judgment) {
      const extraction = await attemptReviewExtraction(
        request.judgment,
        request.changeName,
        run.text,
        request.signal,
      );
      if (extraction.accepted) {
        return { review: extraction.submission, toolNames: run.toolNames, extraction: extraction.mark };
      }
      unactedRecordId = extraction.recordId ?? unactedRecordId;
    }

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
    correction = planningReviewCorrection(reason);
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
    ...(options.judgment ? { judgment: options.judgment } : {}),
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
    ...(response.extraction ? { extraction: response.extraction } : {}),
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
