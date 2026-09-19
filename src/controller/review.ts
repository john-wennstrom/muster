import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  discoverReviewedArtifacts,
  hashReviewedArtifacts,
} from "../review/artifact-digest.ts";
import {
  dispatchPlanningReview,
  type PlanningReviewAssignment,
  type PlanningReviewDispatchOptions,
  type PlanningReviewDispatchResult,
} from "../review/planning-reviewer.ts";
import {
  createReviewArtifact,
  parseReviewArtifact,
  type PlanningReviewArtifact,
  writeReviewArtifact,
} from "../review/review-artifact.ts";
import { HarnessError } from "../shared/errors.ts";

export interface ReviewChangeInput extends Omit<PlanningReviewDispatchOptions, "cwd" | "prompt"> {
  repositoryRoot: string;
  changeRoot: string;
  prompt?: string;
}

export interface ReviewChangeResult {
  review: PlanningReviewArtifact;
  assignment: PlanningReviewAssignment;
  reviewedPaths: readonly string[];
  nextAction: "refine" | "implement";
}

export interface ReviewControllerDependencies {
  discoverArtifacts: typeof discoverReviewedArtifacts;
  hashArtifacts: typeof hashReviewedArtifacts;
  dispatchReview(options: PlanningReviewDispatchOptions): Promise<PlanningReviewDispatchResult>;
  readExistingReview(path: string): Promise<PlanningReviewArtifact | null>;
  writeReview(path: string, review: PlanningReviewArtifact): Promise<void>;
  now(): Date;
}

async function readExistingReview(path: string): Promise<PlanningReviewArtifact | null> {
  try {
    return parseReviewArtifact(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const defaultDependencies: ReviewControllerDependencies = {
  discoverArtifacts: discoverReviewedArtifacts,
  hashArtifacts: hashReviewedArtifacts,
  dispatchReview: dispatchPlanningReview,
  readExistingReview,
  writeReview: writeReviewArtifact,
  now: () => new Date(),
};

function reviewPrompt(
  paths: readonly string[],
  artifactDigest: string,
  additionalPrompt?: string,
): string {
  return [
    "Perform an independent planning review. Read every artifact in this reviewed set:",
    ...paths.map((path) => `- ${path}`),
    "",
    `The controller-calculated artifact digest is ${artifactDigest}.`,
    "Return APPROVE only when there are no critical findings or required changes; otherwise return REVISE.",
    additionalPrompt?.trim(),
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export async function reviewChange(
  input: ReviewChangeInput,
  overrides: Partial<ReviewControllerDependencies> = {},
): Promise<ReviewChangeResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const artifacts = await dependencies.discoverArtifacts(input.repositoryRoot, input.changeRoot);
  const artifactDigest = await dependencies.hashArtifacts(artifacts);
  const reviewPath = resolve(input.changeRoot, "review.md");
  const existingReview = await dependencies.readExistingReview(reviewPath);
  const {
    repositoryRoot: _repositoryRoot,
    changeRoot: _changeRoot,
    prompt: additionalPrompt,
    ...dispatchInput
  } = input;
  const dispatched = await dependencies.dispatchReview({
    ...dispatchInput,
    cwd: input.repositoryRoot,
    prompt: reviewPrompt(
      artifacts.map((artifact) => artifact.relativePath),
      artifactDigest,
      additionalPrompt,
    ),
  });

  const currentDigest = await dependencies.hashArtifacts(
    await dependencies.discoverArtifacts(input.repositoryRoot, input.changeRoot),
  );
  if (currentDigest !== artifactDigest) {
    throw new HarnessError(
      "REVIEW_ARTIFACT_INVALID",
      "Reviewed artifacts changed before the planning review could be persisted",
      { changeName: input.changeName, reviewedDigest: artifactDigest, currentDigest },
    );
  }

  const review = createReviewArtifact({
    schemaVersion: 1,
    round: (existingReview?.round ?? 0) + 1,
    reviewedAt: dependencies.now().toISOString(),
    model: dispatched.assignment.reviewerModel,
    artifactDigest,
    requestedVerdict: dispatched.review.verdict,
    criticalFindings: dispatched.review.criticalFindings,
    requiredChanges: dispatched.review.requiredChanges,
    recommendations: dispatched.review.recommendations,
  });
  await dependencies.writeReview(reviewPath, review);

  return {
    review,
    assignment: dispatched.assignment,
    reviewedPaths: artifacts.map((artifact) => artifact.relativePath),
    // REVISE means the artifacts themselves need to change; re-running review
    // against the same digest would just persist the same verdict forever.
    // `refine` is what actually acts on `requiredChanges` — pendingReviewFeedback
    // (change/phases/planning.ts) folds this review's requiredChanges into the
    // next refine prompt automatically.
    nextAction: review.verdict === "APPROVE" ? "implement" : "refine",
  };
}