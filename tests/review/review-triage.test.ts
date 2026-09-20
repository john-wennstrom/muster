import { describe, expect, test } from "bun:test";
import { createReviewArtifact, type PlanningReviewArtifact } from "../../src/review/review-artifact.ts";
import {
  REVIEW_TRIAGE_MAX_CONSECUTIVE,
  buildReviewTriageInput,
  evaluateReviewTriageEligibility,
  reviewBasisDigest,
  reviewTriageEvidence,
  type ReviewTriageEligibilityInput,
} from "../../src/review/review-triage.ts";
import type { ReviewSnapshot } from "../../src/review/review-snapshot.ts";
import { DIFF_TOTAL_LIMIT_BYTES } from "../../src/review/text-diff.ts";

const proposalPath = "openspec/changes/x/proposal.md";
const designPath = "openspec/changes/x/design.md";
const tasksPath = "openspec/changes/x/tasks.md";
const specPath = "openspec/changes/x/specs/x/spec.md";
const digest = (character: string) => character.repeat(64);

const approvedFiles = {
  [proposalPath]: digest("1"),
  [designPath]: digest("2"),
  [tasksPath]: digest("3"),
  [specPath]: digest("4"),
};

const snapshot: ReviewSnapshot = {
  schemaVersion: 1,
  artifactDigest: digest("a"),
  savedAt: "2026-09-20T12:00:00.000Z",
  files: approvedFiles,
  proposal: { path: proposalPath, text: "# Proposal\nAdd serch.\n" },
  design: { path: designPath, text: "# Design\nUse a palette.\n" },
};

function review(overrides: Partial<PlanningReviewArtifact> = {}, verdict: "APPROVE" | "REVISE" = "APPROVE") {
  return createReviewArtifact({
    schemaVersion: 1,
    round: 1,
    reviewedAt: "2026-09-20T12:00:00.000Z",
    model: "openai/reviewer",
    artifactDigest: digest("a"),
    requestedVerdict: verdict,
    criticalFindings: [],
    requiredChanges: verdict === "REVISE" ? ["Fix it."] : [],
    recommendations: ["Keep the palette in one module."],
    ...overrides,
  });
}

const carriedReview = (count: number) => review({
  artifactDigest: digest("b"),
  round: 1 + count,
  carriedForward: { basisDigest: digest("a"), count, recordId: "decision-1", evidence: [] },
});

function input(overrides: Partial<ReviewTriageEligibilityInput> = {}): ReviewTriageEligibilityInput {
  return {
    existingReview: review(),
    snapshot,
    currentFiles: { ...approvedFiles, [proposalPath]: digest("9") },
    proposalPath,
    designPath,
    hasInstructions: false,
    ...overrides,
  };
}

describe("review triage eligibility", () => {
  test("a proposal-only edit after an approval is eligible", () => {
    expect(evaluateReviewTriageEligibility(input())).toEqual({ eligible: true, changedProse: [proposalPath] });
  });

  test("a design-only edit and an edit to both are eligible and name what changed, proposal first", () => {
    expect(evaluateReviewTriageEligibility(input({
      currentFiles: { ...approvedFiles, [designPath]: digest("8") },
    }))).toEqual({ eligible: true, changedProse: [designPath] });
    expect(evaluateReviewTriageEligibility(input({
      currentFiles: { ...approvedFiles, [designPath]: digest("8"), [proposalPath]: digest("9") },
    }))).toEqual({ eligible: true, changedProse: [proposalPath, designPath] });
  });

  test("each condition failing alone is ineligible, with its reason", () => {
    const cases: readonly [string, Partial<ReviewTriageEligibilityInput>, string][] = [
      ["no review on disk", { existingReview: null }, "no_previous_review"],
      ["previous review revised", { existingReview: review({}, "REVISE") }, "previous_not_approved"],
      ["no retained copy", { snapshot: null }, "no_snapshot"],
      ["retained copy of another review", { snapshot: { ...snapshot, artifactDigest: digest("f") } }, "no_snapshot"],
      ["additional instructions", { hasInstructions: true }, "instructions_given"],
      ["a specification changed", { currentFiles: { ...input().currentFiles, [specPath]: digest("7") } }, "non_prose_changed"],
      ["the task list changed", { currentFiles: { ...input().currentFiles, [tasksPath]: digest("7") } }, "non_prose_changed"],
      ["a specification was added", { currentFiles: { ...input().currentFiles, "openspec/changes/x/specs/y/spec.md": digest("7") } }, "non_prose_changed"],
      ["a specification was removed", {
        currentFiles: Object.fromEntries(Object.entries(input().currentFiles).filter(([path]) => path !== specPath)),
      }, "non_prose_changed"],
      ["nothing changed", { currentFiles: approvedFiles }, "no_change"],
      ["the proposal is missing from the current set", {
        currentFiles: Object.fromEntries(Object.entries(input().currentFiles).filter(([path]) => path !== proposalPath)),
      }, "non_prose_changed"],
    ];
    for (const [label, overrides, reason] of cases) {
      expect({ label, result: evaluateReviewTriageEligibility(input(overrides)) })
        .toEqual({ label, result: { eligible: false, reason } as never });
    }
  });

  test("a prose edit alongside a specification edit is ineligible", () => {
    expect(evaluateReviewTriageEligibility(input({
      currentFiles: { ...approvedFiles, [proposalPath]: digest("9"), [specPath]: digest("7") },
    }))).toEqual({ eligible: false, reason: "non_prose_changed" });
  });

  test("the cap is three consecutive carry-forwards, counted from the review's own mark", () => {
    expect(REVIEW_TRIAGE_MAX_CONSECUTIVE).toBe(3);
    for (const count of [1, 2]) {
      expect(evaluateReviewTriageEligibility(input({ existingReview: carriedReview(count) })).eligible).toBe(true);
    }
    expect(evaluateReviewTriageEligibility(input({ existingReview: carriedReview(3) })))
      .toEqual({ eligible: false, reason: "carry_forward_cap" });
  });

  test("a carried-forward review is compared against the copy of the review it stands on", () => {
    expect(reviewBasisDigest(review())).toBe(digest("a"));
    expect(reviewBasisDigest(carriedReview(1))).toBe(digest("a"));
    // The snapshot retained for the carried review's own digest is not the basis.
    expect(evaluateReviewTriageEligibility(input({
      existingReview: carriedReview(1),
      snapshot: { ...snapshot, artifactDigest: digest("b") },
    }))).toEqual({ eligible: false, reason: "no_snapshot" });
  });
});

describe("review triage input", () => {
  const sources = {
    snapshot,
    proposalText: "# Proposal\nAdd search.\n",
    designText: snapshot.design.text,
    recommendations: ["Keep the palette in one module."],
  };

  test("holds the two diffs and the recommendations", () => {
    const built = buildReviewTriageInput(sources);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.proposalDiff).toBe("@@ -1,2 +1,2 @@\n # Proposal\n-Add serch.\n+Add search.\n");
    expect(built.input.designDiff).toBe("");
    expect(built.input.recommendations).toEqual(["Keep the palette in one module."]);
  });

  test("two diffs over the cap are unavailable instead of truncated", () => {
    const half = "x".repeat(DIFF_TOTAL_LIMIT_BYTES / 2 + 100);
    expect(buildReviewTriageInput({ ...sources, proposalText: `${half}\n`, designText: `${half}\n` }))
      .toEqual({ ok: false, reason: "state_too_large" });
  });
});

describe("review triage evidence", () => {
  test("lists the judged answers, one line each", () => {
    expect(reviewTriageEvidence({
      materiality: 0,
      materialityConfidence: 0.95,
      changes: {
        changes_requirements: 0.05,
        changes_scenarios: 0.02,
        changes_tasks: 0.01,
        changes_scopes: 0.03,
        contradicts_approval: 0.04,
      },
    })).toEqual([
      "materiality: 0 (confidence 0.95)",
      "changes_requirements: 0.05",
      "changes_scenarios: 0.02",
      "changes_tasks: 0.01",
      "changes_scopes: 0.03",
      "contradicts_approval: 0.04",
    ]);
  });
});
