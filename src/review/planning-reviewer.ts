import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { newRun, type AgentRun } from "../../extensions/fusion-harness/modules/runtime.ts";
import {
  runLegacyReadOnlyChild,
  type RunLegacyReadOnlyChildOptions,
} from "../agents/legacy-adapter.ts";
import { HarnessError } from "../shared/errors.ts";
import {
  planningReviewArtifactSchema,
  type PlanningReviewArtifact,
} from "./review-artifact.ts";

const REVIEW_TOOLS = ["muster_read", "muster_search"] as const;
const reviewToolSet = new Set<string>(REVIEW_TOOLS);

export interface ReviewModelCandidate {
  model: string;
  available: boolean;
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
  review: PlanningReviewArtifact;
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
  review: PlanningReviewArtifact;
  assignment: PlanningReviewAssignment;
}

export type PlanningReviewerChildRunner = (
  options: RunLegacyReadOnlyChildOptions,
) => Promise<AgentRun>;

function parseReviewerJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new HarnessError(
      "REVIEW_ARTIFACT_INVALID",
      "Planning reviewer did not return one JSON review object",
      {},
      { cause },
    );
  }
}

export async function runBrokeredPlanningReviewer(
  request: PlanningReviewerRequest,
  childRunner: PlanningReviewerChildRunner = runLegacyReadOnlyChild,
): Promise<PlanningReviewerResponse> {
  const run = newRun("REVIEWER", request.model);
  await childRunner({
    run,
    prompt: `${request.prompt}\n\nReturn exactly one JSON object matching the planning review contract; no markdown or code fence.`,
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
    timeoutMs: 120_000,
    signal: request.signal,
  });
  if (run.status !== "done") {
    throw new HarnessError(
      "REVIEW_ARTIFACT_INVALID",
      `Planning reviewer failed with status ${run.status}`,
      { runId: request.runId, exitCode: run.exitCode, error: run.errorMessage },
    );
  }
  const parsed = planningReviewArtifactSchema.safeParse(parseReviewerJson(run.text));
  if (!parsed.success) {
    throw new HarnessError(
      "REVIEW_ARTIFACT_INVALID",
      "Planning reviewer returned an incompatible review object",
      { issues: parsed.error.issues },
    );
  }
  return { review: parsed.data, toolNames: run.toolNames };
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
    tools: REVIEW_TOOLS,
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

  const parsedReview = planningReviewArtifactSchema.safeParse(response.review);
  if (!parsedReview.success || parsedReview.data.model !== candidate.model) {
    throw new HarnessError(
      "REVIEW_ARTIFACT_INVALID",
      "Planning reviewer returned invalid or mismatched review evidence",
      {
        runId: options.runId,
        expectedModel: candidate.model,
        reportedModel: response.review?.model,
        issues: parsedReview.success ? [] : parsedReview.error.issues,
      },
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
      tools: REVIEW_TOOLS,
    },
  };
}
