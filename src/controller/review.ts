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
import {
  assessReviewTriage,
  reconcileReviewTriage,
  reviewBasisDigest,
  reviewTriageEvidence,
  type ReviewedSet,
  type ReviewTriageJudgment,
} from "../review/review-triage.ts";
import { loadReviewSnapshot, saveReviewSnapshot, type ReviewSnapshot } from "../review/review-snapshot.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { HarnessError } from "../shared/errors.ts";

export interface ReviewChangeInput extends Omit<PlanningReviewDispatchOptions, "cwd" | "prompt"> {
  repositoryRoot: string;
  changeRoot: string;
  prompt?: string;
  /**
   * Plan-time task quality findings that are still current, already rendered. They reach the
   * reviewer's prompt as unverified notes and touch nothing else: the verdict and every field
   * of the review artifact come from the reviewer's output alone.
   */
  taskQualityNotes?: readonly string[];
  /**
   * Present only when review triage is enabled. It lets an approval be carried across an edit
   * that only touched the proposal or the design, and turns on retention of what each approving
   * full review approved. Absent, every changed artifact set gets a full review, and nothing is
   * retained.
   */
  triage?: ReviewTriageJudgment;
}

export interface ReviewChangeResult {
  review: PlanningReviewArtifact;
  /** Null when the approval was carried forward: no reviewer was dispatched. */
  assignment: PlanningReviewAssignment | null;
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
  /** Reads a reviewed file's text, for review triage. */
  readText(path: string): Promise<string>;
  loadSnapshot(store: AtomicJsonStore, changeName: string, artifactDigest: string): Promise<ReviewSnapshot | null>;
  saveSnapshot: typeof saveReviewSnapshot;
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
  readText: (path) => readFile(path, "utf8"),
  loadSnapshot: loadReviewSnapshot,
  saveSnapshot: saveReviewSnapshot,
};

function taskQualitySection(notes: readonly string[]): string[] {
  if (notes.length === 0) return [];
  return [
    "",
    "Unverified automated notes about the task list, from a check made when it was planned. They may be wrong. Confirm or dismiss each by reading the artifacts, and report only what you confirm as your own finding:",
    ...notes.map((note) => `- ${note}`),
  ];
}

function reviewPrompt(
  paths: readonly string[],
  artifactDigest: string,
  additionalPrompt?: string,
  taskQualityNotes: readonly string[] = [],
): string {
  return [
    "Perform an independent planning review. Read every artifact in this reviewed set:",
    ...paths.map((path) => `- ${path}`),
    "",
    `The controller-calculated artifact digest is ${artifactDigest}.`,
    "Return APPROVE only when there are no critical findings or required changes; otherwise return REVISE.",
    ...taskQualitySection(taskQualityNotes),
    additionalPrompt?.trim(),
  ].filter((line): line is string => Boolean(line)).join("\n");
}

/** A digest for every reviewed file and the text of the proposal and the design. */
async function captureReviewedSet(
  dependencies: ReviewControllerDependencies,
  changeRoot: string,
  artifacts: Awaited<ReturnType<typeof discoverReviewedArtifacts>>,
): Promise<ReviewedSet> {
  const files: Record<string, string> = {};
  for (const artifact of artifacts) {
    files[artifact.relativePath] = await dependencies.hashArtifacts([artifact]);
  }
  const prose = async (name: "proposal.md" | "design.md") => {
    const artifact = artifacts.find((candidate) => candidate.absolutePath === resolve(changeRoot, name));
    if (!artifact) {
      throw new HarnessError("REVIEW_ARTIFACT_INVALID", `Reviewed artifact set has no ${name}`, { changeRoot });
    }
    return { path: artifact.relativePath, text: await dependencies.readText(artifact.absolutePath) };
  };
  return { files, proposal: await prose("proposal.md"), design: await prose("design.md") };
}

export async function reviewChange(
  input: ReviewChangeInput,
  overrides: Partial<ReviewControllerDependencies> = {},
): Promise<ReviewChangeResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const {
    repositoryRoot: _repositoryRoot,
    changeRoot: _changeRoot,
    prompt: additionalPrompt,
    taskQualityNotes,
    triage,
    ...dispatchInput
  } = input;
  let artifacts = await dependencies.discoverArtifacts(input.repositoryRoot, input.changeRoot);
  let artifactDigest = await dependencies.hashArtifacts(artifacts);
  const reviewPath = resolve(input.changeRoot, "review.md");
  const existingReview = await dependencies.readExistingReview(reviewPath);
  const changeRoot = resolve(input.changeRoot);
  const reviewedPaths = () => artifacts.map((artifact) => artifact.relativePath);

  // What the approval to be retained, or the edit to be judged, is made of. Taken with the
  // digest, so that an unchanged digest afterwards means this is what the digest was over.
  let reviewedSet: ReviewedSet | null = null;
  let triageRecordId: string | null = null;
  if (triage?.runtime.enabled) {
    reviewedSet = await captureReviewedSet(dependencies, changeRoot, artifacts);
    const assessment = await assessReviewTriage({
      triage,
      changeName: input.changeName,
      existingReview,
      current: reviewedSet,
      hasInstructions: Boolean(additionalPrompt?.trim()),
      loadSnapshot: (digest) => dependencies.loadSnapshot(triage.store, input.changeName, digest),
      signal: input.signal,
    });
    triageRecordId = assessment.recordId;

    if (assessment.carry) {
      const current = await dependencies.hashArtifacts(
        await dependencies.discoverArtifacts(input.repositoryRoot, input.changeRoot),
      );
      if (current === artifactDigest) {
        const basis = existingReview!;
        const review = createReviewArtifact({
          schemaVersion: 1,
          round: basis.round + 1,
          reviewedAt: dependencies.now().toISOString(),
          // The approval is the basis reviewer's; no field claims a model read the current text.
          model: basis.model,
          artifactDigest,
          requestedVerdict: "APPROVE",
          criticalFindings: [],
          requiredChanges: [],
          recommendations: basis.recommendations,
          carriedForward: {
            basisDigest: reviewBasisDigest(basis),
            count: (basis.carriedForward?.count ?? 0) + 1,
            recordId: assessment.recordId,
            evidence: reviewTriageEvidence(assessment.value),
          },
        });
        await dependencies.writeReview(reviewPath, review);
        return { review, assignment: null, reviewedPaths: reviewedPaths(), nextAction: "implement" };
      }
      // The artifacts changed while judgment ran, so nothing is carried. The full review is of
      // what is there now, and what a later approval retains is that too.
      artifacts = await dependencies.discoverArtifacts(input.repositoryRoot, input.changeRoot);
      artifactDigest = await dependencies.hashArtifacts(artifacts);
      reviewedSet = await captureReviewedSet(dependencies, changeRoot, artifacts);
    }
  }

  const dispatched = await dependencies.dispatchReview({
    ...dispatchInput,
    cwd: input.repositoryRoot,
    prompt: reviewPrompt(
      reviewedPaths(),
      artifactDigest,
      additionalPrompt,
      taskQualityNotes,
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
    ...(dispatched.extraction ? { extraction: dispatched.extraction } : {}),
  });
  await dependencies.writeReview(reviewPath, review);

  if (triage && reviewedSet) {
    await reconcileReviewTriage(triage, input.changeName, triageRecordId, review);
    if (review.verdict === "APPROVE") {
      // Retention is a convenience for a later edit; failing to keep it costs that edit a full review.
      await dependencies.saveSnapshot(triage.store, input.changeName, {
        artifactDigest,
        files: { ...reviewedSet.files },
        proposal: reviewedSet.proposal,
        design: reviewedSet.design,
      }, dependencies.now).catch(() => undefined);
    }
  }

  return {
    review,
    assignment: dispatched.assignment,
    reviewedPaths: reviewedPaths(),
    // REVISE means the artifacts themselves need to change; re-running review
    // against the same digest would just persist the same verdict forever.
    // `refine` is what actually acts on `requiredChanges` — pendingReviewFeedback
    // (change/phases/planning.ts) folds this review's requiredChanges into the
    // next refine prompt automatically.
    nextAction: review.verdict === "APPROVE" ? "implement" : "refine",
  };
}
