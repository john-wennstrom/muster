import type { RunManifest } from "../persistence/records.ts";
import type { Lane, LaneSource } from "./lane.ts";
import type { PlanningReviewArtifact } from "../review/review-artifact.ts";
import { HarnessError } from "../shared/errors.ts";

export type ChangeLifecycle = RunManifest["lifecycle"];

/** The change's lane as status shows it: which lane, who chose it, and how often it escalated. */
export interface SnapshotLane {
  lane: Lane;
  source: LaneSource;
  escalations: number;
}

/** A change with no lane record was planned before lanes existed, and is medium. */
export const DEFAULT_SNAPSHOT_LANE: SnapshotLane = Object.freeze({ lane: "medium", source: "pattern", escalations: 0 });

interface TimedObservation {
  observedAt: string;
}

export interface ChangeSnapshotInput {
  capturedAt: string;
  openSpec: TimedObservation & {
    changeName: string;
    planningComplete: boolean;
    tasks: Readonly<Record<string, boolean>>;
    artifactDigest: string;
  };
  repository: TimedObservation & {
    repositoryId: string;
    commonDirectory: string;
    worktree: string;
    head: string;
    indexDigest: string;
    diffDigest: string;
    sourceDigest: string;
  };
  runtime: (TimedObservation & { manifest: RunManifest }) | null;
  review: (TimedObservation & { artifact: PlanningReviewArtifact }) | null;
  validation: (TimedObservation & {
    result: "PASS" | "FAIL";
    artifactDigest: string;
    sourceDigest: string;
  }) | null;
  pendingCheckpointIds: readonly string[];
  lane?: SnapshotLane;
}

export interface ChangeSnapshot {
  changeName: string;
  lifecycle: ChangeLifecycle;
  capturedAt: string;
  observations: {
    openSpec: string;
    repository: string;
    runtime?: string;
    review?: string;
    validation?: string;
  };
  digests: {
    artifact: string;
    source: string;
    head: string;
    index: string;
    diff: string;
  };
  freshness: {
    review: "missing" | "current" | "stale";
    validation: "missing" | "current" | "stale" | "failed";
  };
  taskStates: Readonly<Record<string, boolean>>;
  pendingCheckpointIds: readonly string[];
  discrepancies: readonly string[];
  /** Always set by the snapshot factory; optional so a snapshot built by hand still reads as medium. */
  lane?: SnapshotLane;
}

function inconsistent(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("SNAPSHOT_INCONSISTENT", message, details);
}

function validateObservationTimes(input: ChangeSnapshotInput): void {
  const capturedAt = Date.parse(input.capturedAt);
  if (!Number.isFinite(capturedAt)) {
    inconsistent("Snapshot capture time is invalid", { capturedAt: input.capturedAt });
  }
  const observations: Array<[string, TimedObservation | null]> = [
    ["openSpec", input.openSpec],
    ["repository", input.repository],
    ["runtime", input.runtime],
    ["review", input.review],
    ["validation", input.validation],
  ];
  for (const [source, observation] of observations) {
    if (!observation) continue;
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > capturedAt) {
      inconsistent("Snapshot contains an invalid or future observation", {
        source,
        observedAt: observation.observedAt,
        capturedAt: input.capturedAt,
      });
    }
  }
}

function validateIdentity(input: ChangeSnapshotInput): void {
  const manifest = input.runtime?.manifest;
  if (!manifest) return;
  if (
    manifest.changeName !== input.openSpec.changeName ||
    manifest.repository.id !== input.repository.repositoryId ||
    manifest.repository.commonDirectory !== input.repository.commonDirectory ||
    manifest.worktree.path !== input.repository.worktree
  ) {
    inconsistent("Snapshot combines observations from different change or repository identities", {
      openSpecChange: input.openSpec.changeName,
      runtimeChange: manifest.changeName,
      repositoryId: input.repository.repositoryId,
      runtimeRepositoryId: manifest.repository.id,
      worktree: input.repository.worktree,
      runtimeWorktree: manifest.worktree.path,
    });
  }
}

function deriveLifecycle(
  input: ChangeSnapshotInput,
  reviewFreshness: ChangeSnapshot["freshness"]["review"],
  validationFreshness: ChangeSnapshot["freshness"]["validation"],
): ChangeLifecycle {
  if (!input.openSpec.planningComplete) return "PLANNING";
  if (input.pendingCheckpointIds.length > 0) return "AWAITING_USER";
  if (reviewFreshness !== "current" || input.review?.artifact.verdict !== "APPROVE") {
    return "REVIEW_REQUIRED";
  }

  const runtimeStates = Object.values(input.runtime?.manifest.tasks ?? {});
  if (runtimeStates.includes("design_conflict")) return "DESIGN_CONFLICT";
  if (runtimeStates.includes("debugging")) return "BLOCKED";
  if (runtimeStates.includes("failed")) return "FAILED";
  if (runtimeStates.includes("cancelled")) return "CANCELLED";
  if (runtimeStates.includes("awaiting_user")) return "AWAITING_USER";

  const tasks = Object.values(input.openSpec.tasks);
  const allTasksComplete = tasks.length > 0 && tasks.every(Boolean);
  if (allTasksComplete) {
    return validationFreshness === "current" ? "VERIFIED" : "VERIFYING";
  }
  if (runtimeStates.some((state) => state === "running" || state === "completed")) {
    return "IMPLEMENTING";
  }
  return "READY";
}

export function createChangeSnapshot(input: ChangeSnapshotInput): ChangeSnapshot {
  validateObservationTimes(input);
  validateIdentity(input);

  const lane = input.lane ?? DEFAULT_SNAPSHOT_LANE;
  // A lint approval stands in for a reviewer only on the small lane, so escalating the change
  // makes it stale and the next review dispatches a reviewer.
  const lintOutsideSmall = input.review?.artifact.mode === "lint" && lane.lane !== "small";
  const reviewFreshness: ChangeSnapshot["freshness"]["review"] = !input.review
    ? "missing"
    : lintOutsideSmall
      ? "stale"
      : input.review.artifact.artifactDigest === input.openSpec.artifactDigest
        ? "current"
        : "stale";
  const validationFreshness: ChangeSnapshot["freshness"]["validation"] = !input.validation
    ? "missing"
    : input.validation.result === "FAIL"
      ? "failed"
      : input.validation.artifactDigest === input.openSpec.artifactDigest &&
          input.validation.sourceDigest === input.repository.sourceDigest
        ? "current"
        : "stale";

  const discrepancies: string[] = [];
  if (input.runtime?.manifest.artifactDigest !== undefined &&
      input.runtime.manifest.artifactDigest !== input.openSpec.artifactDigest) {
    discrepancies.push("Runtime artifact digest differs from current OpenSpec artifacts");
  }
  for (const [taskId, done] of Object.entries(input.openSpec.tasks)) {
    const runtimeState = input.runtime?.manifest.tasks[taskId];
    if (done && runtimeState !== undefined && runtimeState !== "completed") {
      discrepancies.push(`OpenSpec task ${taskId} is complete while runtime state is ${runtimeState}`);
    }
  }

  return Object.freeze({
    changeName: input.openSpec.changeName,
    lifecycle: deriveLifecycle(input, reviewFreshness, validationFreshness),
    capturedAt: input.capturedAt,
    observations: Object.freeze({
      openSpec: input.openSpec.observedAt,
      repository: input.repository.observedAt,
      runtime: input.runtime?.observedAt,
      review: input.review?.observedAt,
      validation: input.validation?.observedAt,
    }),
    digests: Object.freeze({
      artifact: input.openSpec.artifactDigest,
      source: input.repository.sourceDigest,
      head: input.repository.head,
      index: input.repository.indexDigest,
      diff: input.repository.diffDigest,
    }),
    freshness: Object.freeze({
      review: reviewFreshness,
      validation: validationFreshness,
    }),
    taskStates: Object.freeze({ ...input.openSpec.tasks }),
    pendingCheckpointIds: Object.freeze([...input.pendingCheckpointIds]),
    discrepancies: Object.freeze(discrepancies),
    lane: Object.freeze({ ...lane }),
  });
}

const legalTransitions: Readonly<Record<ChangeLifecycle, readonly ChangeLifecycle[]>> = {
  EXPLORE: ["PLANNING", "CANCELLED"],
  PLANNING: ["REVIEW_REQUIRED", "BLOCKED", "CANCELLED"],
  REVIEW_REQUIRED: ["PLANNING", "READY", "BLOCKED", "CANCELLED"],
  READY: ["IMPLEMENTING", "REVIEW_REQUIRED", "BLOCKED", "CANCELLED"],
  IMPLEMENTING: ["VERIFYING", "REVIEW_REQUIRED", "AWAITING_USER", "DESIGN_CONFLICT", "BLOCKED", "FAILED", "CANCELLED"],
  VERIFYING: ["VERIFIED", "IMPLEMENTING", "REVIEW_REQUIRED", "BLOCKED", "FAILED", "CANCELLED"],
  VERIFIED: ["FINISHING", "VERIFYING", "REVIEW_REQUIRED", "CANCELLED"],
  FINISHING: ["COMPLETE", "VERIFIED", "BLOCKED", "FAILED"],
  COMPLETE: [],
  AWAITING_USER: ["IMPLEMENTING", "READY", "BLOCKED", "CANCELLED"],
  DESIGN_CONFLICT: ["PLANNING", "REVIEW_REQUIRED", "CANCELLED"],
  BLOCKED: ["PLANNING", "REVIEW_REQUIRED", "READY", "IMPLEMENTING", "VERIFYING", "CANCELLED"],
  FAILED: ["READY", "IMPLEMENTING", "VERIFYING", "CANCELLED"],
  CANCELLED: [],
};

export function assertLifecycleTransition(
  from: ChangeLifecycle,
  to: ChangeLifecycle,
): void {
  if (from === to || legalTransitions[from].includes(to)) return;
  throw new HarnessError(
    "LIFECYCLE_TRANSITION_INVALID",
    `Illegal lifecycle transition from ${from} to ${to}`,
    { from, to, allowed: legalTransitions[from] },
  );
}