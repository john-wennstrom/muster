import { describe, expect, test } from "bun:test";
import {
  assertLifecycleTransition,
  createChangeSnapshot,
  type ChangeSnapshotInput,
} from "../../src/controller/change-snapshot.ts";
import type { RunManifest } from "../../src/persistence/records.ts";
import { createReviewArtifact } from "../../src/review/review-artifact.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const observedAt = "2026-09-12T12:00:00.000Z";
const artifactDigest = "a".repeat(64);
const sourceDigest = "b".repeat(64);

const runtime: RunManifest = {
  schemaVersion: 1,
  runId: "run-1",
  changeName: "add-search",
  lifecycle: "READY",
  repository: { id: "repo-1", commonDirectory: "/repo/.git" },
  worktree: {
    path: "/repo-worktrees/add-search",
    head: "c".repeat(40),
    indexDigest: "index",
    diffDigest: "diff",
  },
  artifactDigest,
  tasks: { "1.1": "ready" },
  modelAssignments: {},
  writer: null,
  checkpoints: [],
  createdAt: observedAt,
  updatedAt: observedAt,
};

function input(overrides: Partial<ChangeSnapshotInput> = {}): ChangeSnapshotInput {
  return {
    capturedAt: observedAt,
    openSpec: {
      observedAt,
      changeName: "add-search",
      planningComplete: true,
      tasks: { "1.1": false },
      artifactDigest,
    },
    repository: {
      observedAt,
      repositoryId: "repo-1",
      commonDirectory: "/repo/.git",
      worktree: "/repo-worktrees/add-search",
      head: "c".repeat(40),
      indexDigest: "index",
      diffDigest: "diff",
      sourceDigest,
    },
    runtime: { observedAt, manifest: runtime },
    review: {
      observedAt,
      artifact: createReviewArtifact({
        schemaVersion: 1,
        round: 1,
        reviewedAt: observedAt,
        model: "openai/reviewer",
        artifactDigest,
        requestedVerdict: "APPROVE",
        criticalFindings: [],
        requiredChanges: [],
        recommendations: [],
      }),
    },
    validation: null,
    pendingCheckpointIds: [],
    ...overrides,
  };
}

describe("a lint approval", () => {
  const lintApproval = () => ({
    observedAt,
    artifact: createReviewArtifact({
      schemaVersion: 1,
      mode: "lint",
      round: 1,
      reviewedAt: observedAt,
      model: "lint",
      artifactDigest,
      requestedVerdict: "APPROVE",
      criticalFindings: [],
      requiredChanges: [],
      recommendations: [],
      lint: { checks: ["artifacts exist and parse"], semanticCheck: "ran", answers: [] },
    }),
  });

  test("is current on the small lane while the digest matches", () => {
    const snapshot = createChangeSnapshot(input({ review: lintApproval(), lane: { lane: "small", source: "judgment", escalations: 0 } }));
    expect(snapshot.freshness.review).toBe("current");
    expect(snapshot.lifecycle).not.toBe("REVIEW_REQUIRED");
  });

  test("goes stale when the change is escalated, so review is required again", () => {
    for (const lane of ["medium", "large"] as const) {
      const snapshot = createChangeSnapshot(input({ review: lintApproval(), lane: { lane, source: "judgment", escalations: 1 } }));
      expect(snapshot.freshness.review).toBe("stale");
      expect(snapshot.lifecycle).toBe("REVIEW_REQUIRED");
    }
  });

  test("is stale on a change with no lane record, which reads as medium", () => {
    expect(createChangeSnapshot(input({ review: lintApproval() })).lifecycle).toBe("REVIEW_REQUIRED");
  });

  test("still goes stale when the artifact digest changes on the small lane", () => {
    const snapshot = createChangeSnapshot(input({
      review: lintApproval(),
      lane: { lane: "small", source: "user", escalations: 0 },
      openSpec: { ...input().openSpec, artifactDigest: "d".repeat(64) },
    }));
    expect(snapshot.freshness.review).toBe("stale");
  });

  test("a reviewer approval is unaffected by the lane", () => {
    for (const lane of ["small", "medium", "large"] as const) {
      expect(createChangeSnapshot(input({ lane: { lane, source: "user", escalations: 0 } })).freshness.review).toBe("current");
    }
  });
});

describe("change lifecycle state machine", () => {
  test("invalidates a stale approval before implementation", () => {
    const staleReview = input().review!;
    const snapshot = createChangeSnapshot(input({
      openSpec: { ...input().openSpec, artifactDigest: "d".repeat(64) },
      review: staleReview,
    }));

    expect(snapshot.lifecycle).toBe("REVIEW_REQUIRED");
    expect(snapshot.freshness.review).toBe("stale");
  });

  test("derives VERIFIED only from current passing validation", () => {
    const base = input({
      openSpec: { ...input().openSpec, tasks: { "1.1": true } },
      runtime: {
        observedAt,
        manifest: { ...runtime, lifecycle: "VERIFYING", tasks: { "1.1": "completed" } },
      },
    });

    expect(createChangeSnapshot(base).lifecycle).toBe("VERIFYING");
    expect(createChangeSnapshot({
      ...base,
      validation: {
        observedAt,
        result: "PASS",
        artifactDigest,
        sourceDigest,
      },
    }).lifecycle).toBe("VERIFIED");
  });

  test("fails closed on mixed repository identity observations", () => {
    expect(() => createChangeSnapshot(input({
      repository: { ...input().repository, repositoryId: "other-repo" },
    }))).toThrow(expect.objectContaining({
      code: "SNAPSHOT_INCONSISTENT",
    }) as HarnessError);
  });

  test("accepts legal transitions and rejects gate-skipping transitions", () => {
    expect(() => assertLifecycleTransition("READY", "IMPLEMENTING")).not.toThrow();
    expect(() => assertLifecycleTransition("READY", "VERIFIED")).toThrow(
      expect.objectContaining({ code: "LIFECYCLE_TRANSITION_INVALID" }) as HarnessError,
    );
  });
});