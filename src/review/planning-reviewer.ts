import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { HarnessError } from "../shared/errors.ts";
import {
  planningReviewArtifactSchema,
  type PlanningReviewArtifact,
} from "./review-artifact.ts";

const REVIEW_TOOLS = ["read", "grep", "find", "ls"] as const;
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