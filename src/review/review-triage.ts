import type { JudgmentRuntime } from "../judgment/ask.ts";
import { reviewTriageDecision, reviewTriageState, type ReviewTriageGateValue, type ReviewTriageInput } from "../judgment/decisions/review-triage.ts";
import { tryJudge } from "../judgment/try.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { REVIEW_TRIAGE_CHANGE_QUESTION_IDS, REVIEW_TRIAGE_QUESTION_IDS } from "../judgment/questions.ts";
import type { PlanningReviewArtifact } from "./review-artifact.ts";
import type { ReviewSnapshot } from "./review-snapshot.ts";
import { boundedDiffs } from "./text-diff.ts";

/**
 * Whether an approved planning review may be carried across an edit. Eligibility is decided here,
 * by code, before any model is asked: judgment only ever sees an edit that has already passed
 * every rule below, so a specification edit, a task-list edit, a revise, a missing copy, a fourth
 * edit in a row, or an edit with extra instructions never generates a request.
 */

/** Consecutive carry-forwards allowed since a full review; accumulated small edits are not one. */
export const REVIEW_TRIAGE_MAX_CONSECUTIVE = 3;

export type ReviewTriageIneligibleReason =
  | "no_previous_review"
  | "previous_not_approved"
  | "no_snapshot"
  | "instructions_given"
  | "carry_forward_cap"
  | "no_change"
  | "non_prose_changed";

export type ReviewTriageEligibility =
  | {
      readonly eligible: true;
      /** The repository-relative paths of the prose files that differ, proposal first. */
      readonly changedProse: readonly string[];
    }
  | { readonly eligible: false; readonly reason: ReviewTriageIneligibleReason };

export interface ReviewTriageEligibilityInput {
  /** The review on disk, or null when there is none. */
  readonly existingReview: PlanningReviewArtifact | null;
  /** The retained copy of the last full review's approved artifacts, or null when none exists. */
  readonly snapshot: ReviewSnapshot | null;
  /** A digest for every file in the current reviewed set, keyed by repository-relative path. */
  readonly currentFiles: Readonly<Record<string, string>>;
  readonly proposalPath: string;
  readonly designPath: string;
  /** Whether the person gave additional review instructions. */
  readonly hasInstructions: boolean;
}

/** The digest of the full review an existing review stands on: its own, or the one it carried. */
export function reviewBasisDigest(review: PlanningReviewArtifact): string {
  return review.carriedForward?.basisDigest ?? review.artifactDigest;
}

export function evaluateReviewTriageEligibility(
  input: ReviewTriageEligibilityInput,
): ReviewTriageEligibility {
  const ineligible = (reason: ReviewTriageIneligibleReason): ReviewTriageEligibility => ({ eligible: false, reason });
  const { existingReview, snapshot } = input;

  if (!existingReview) return ineligible("no_previous_review");
  if (existingReview.verdict !== "APPROVE") return ineligible("previous_not_approved");
  // Explicit instructions are how a person asks the reviewer to look at something in particular.
  if (input.hasInstructions) return ineligible("instructions_given");
  if (!snapshot || snapshot.artifactDigest !== reviewBasisDigest(existingReview)) return ineligible("no_snapshot");
  if ((existingReview.carriedForward?.count ?? 0) >= REVIEW_TRIAGE_MAX_CONSECUTIVE) {
    return ineligible("carry_forward_cap");
  }

  const prose = [input.proposalPath, input.designPath];
  for (const path of prose) {
    if (!(path in input.currentFiles) || !(path in snapshot.files)) return ineligible("non_prose_changed");
  }
  // Anything but the two prose files must be exactly what was approved: none changed, added, or removed.
  const paths = new Set([...Object.keys(input.currentFiles), ...Object.keys(snapshot.files)]);
  for (const path of paths) {
    if (prose.includes(path)) continue;
    if (input.currentFiles[path] !== snapshot.files[path]) return ineligible("non_prose_changed");
  }

  const changedProse = prose.filter((path) => input.currentFiles[path] !== snapshot.files[path]);
  return changedProse.length === 0 ? ineligible("no_change") : { eligible: true, changedProse };
}

export interface ReviewTriageInputSources {
  readonly snapshot: ReviewSnapshot;
  /** The current text of the two prose files. */
  readonly proposalText: string;
  readonly designText: string;
  /** The recommendations of the approving review. */
  readonly recommendations: readonly string[];
}

export type BuiltReviewTriageInput =
  | { readonly ok: true; readonly input: ReviewTriageInput }
  | { readonly ok: false; readonly reason: "state_too_large" };

/**
 * The decision's input from the retained approved text and the current text. Unavailable, which
 * means a full review, when the two diffs together exceed the cap; an edit that large is not the
 * kind this is for, and a truncated diff would misstate the edit.
 */
export function buildReviewTriageInput(sources: ReviewTriageInputSources): BuiltReviewTriageInput {
  const diffs = boundedDiffs([
    { path: sources.snapshot.proposal.path, before: sources.snapshot.proposal.text, after: sources.proposalText },
    { path: sources.snapshot.design.path, before: sources.snapshot.design.text, after: sources.designText },
  ]);
  if (diffs.exceeded) return { ok: false, reason: "state_too_large" };
  return {
    ok: true,
    input: {
      proposalDiff: diffs.diffs[0]!.diff,
      designDiff: diffs.diffs[1]!.diff,
      recommendations: sources.recommendations,
    },
  };
}

/** One evidence line per judged answer, for the carried-forward review artifact. */
export function reviewTriageEvidence(value: ReviewTriageGateValue): string[] {
  return [
    `${REVIEW_TRIAGE_QUESTION_IDS.materiality}: ${value.materiality} (confidence ${value.materialityConfidence})`,
    ...REVIEW_TRIAGE_CHANGE_QUESTION_IDS.flatMap((id) => {
      const probability = value.changes[id];
      return probability === undefined ? [] : [`${id}: ${probability}`];
    }),
  ];
}

/** What triage needs of the judgment layer: the runtime to ask, and the store its records live in. */
export interface ReviewTriageJudgment {
  readonly runtime: JudgmentRuntime;
  readonly store: AtomicJsonStore;
}

/** The current reviewed set as triage sees it: a digest for every file, and the two prose texts. */
export interface ReviewedSet {
  readonly files: Readonly<Record<string, string>>;
  readonly proposal: { readonly path: string; readonly text: string };
  readonly design: { readonly path: string; readonly text: string };
}

export type ReviewTriageAssessment =
  | {
      readonly carry: true;
      readonly value: ReviewTriageGateValue;
      /** Always present: a carried-forward review is never written without its provenance. */
      readonly recordId: string;
    }
  | {
      readonly carry: false;
      /** Why not, for the caller's outcome; `judged` covers every answer of the judgment layer. */
      readonly reason: ReviewTriageIneligibleReason | "state_too_large" | "judged";
      /** The decision record, when one was written, so the full review's result can be compared. */
      readonly recordId: string | null;
    };

export interface ReviewTriageAssessmentInput {
  readonly triage: ReviewTriageJudgment;
  readonly changeName: string;
  readonly existingReview: PlanningReviewArtifact | null;
  readonly current: ReviewedSet;
  readonly hasInstructions: boolean;
  /** Loads the retained copy for a digest; null when there is none. */
  readonly loadSnapshot: (artifactDigest: string) => Promise<ReviewSnapshot | null>;
  readonly signal?: AbortSignal;
}

const notCarried = (
  reason: Extract<ReviewTriageAssessment, { carry: false }>["reason"],
  recordId: string | null = null,
): ReviewTriageAssessment => ({ carry: false, reason, recordId });

/**
 * Decides whether the previous approval can be carried across the current edit. Sends nothing
 * for an edit that is not eligible, and for a state over the cap. Carries only in enforce mode,
 * only when the gate acted, and only when the decision record can be named. Every other case,
 * including every failure, is a full review: it never throws for an operational failure.
 */
export async function assessReviewTriage(input: ReviewTriageAssessmentInput): Promise<ReviewTriageAssessment> {
  const { existingReview, current } = input;
  // Loading the snapshot is real work, so it is skipped when judgment is off.
  if (!input.triage.runtime.enabled) return notCarried("judged");

  let snapshot: ReviewSnapshot | null = null;
  if (existingReview?.verdict === "APPROVE") {
    try {
      snapshot = await input.loadSnapshot(reviewBasisDigest(existingReview));
    } catch {
      snapshot = null;
    }
  }
  const eligibility = evaluateReviewTriageEligibility({
    existingReview,
    snapshot,
    currentFiles: current.files,
    proposalPath: current.proposal.path,
    designPath: current.design.path,
    hasInstructions: input.hasInstructions,
  });
  if (!eligibility.eligible) return notCarried(eligibility.reason);

  const built = buildReviewTriageInput({
    snapshot: snapshot!,
    proposalText: current.proposal.text,
    designText: current.design.text,
    recommendations: existingReview!.recommendations,
  });
  if (!built.ok) return notCarried(built.reason);

  const verdict = await tryJudge(input.triage.runtime, reviewTriageDecision, {
    input: built.input,
    changeName: input.changeName,
    phase: "planning",
    state: reviewTriageState(built.input),
    signal: input.signal,
  });
  if (!verdict) return notCarried("judged");
  if (verdict.kind !== "enforce" || !verdict.outcome.act || verdict.recordId === null) {
    return notCarried("judged", verdict.recordId);
  }
  return { carry: true, value: verdict.outcome.value, recordId: verdict.recordId };
}

/**
 * Records what the full review concluded beside the triage decision it stood in for. The
 * agreement is set only where the gate would have carried the approval forward, and is that the
 * review approved: a would-have-carried decision followed by a review that did not approve is a
 * false skip. Measurement only: it never throws.
 */
export async function reconcileReviewTriage(
  triage: ReviewTriageJudgment,
  changeName: string,
  recordId: string | null,
  review: Pick<PlanningReviewArtifact, "verdict" | "criticalFindings" | "requiredChanges">,
): Promise<void> {
  const record = await triage.runtime.reconcile(changeName, recordId, {
    observed: {
      reviewVerdict: review.verdict,
      reviewRequiredChanges: review.requiredChanges.length,
      reviewCriticalFindings: review.criticalFindings.length,
    },
  });
  if (!record?.wouldHaveActed) return;
  await triage.runtime.reconcile(changeName, recordId, { agreed: review.verdict === "APPROVE" });
}
