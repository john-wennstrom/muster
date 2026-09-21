import { resolve } from "node:path";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import {
  planLintAssessment,
  planLintDecision,
  planLintState,
  presentPlanLintFindings,
  type PlanLintFinding,
  type PlanLintGateValue,
} from "../judgment/decisions/plan-lint.ts";
import { tryJudge, type TriedVerdict } from "../judgment/try.ts";
import type { OpenSpecAdapter } from "../openspec/adapter.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { lintChange } from "../review/plan-lint.ts";
import { buildPlanLintInput } from "../review/plan-lint-input.ts";
import { createReviewArtifact, type PlanningReviewArtifact } from "../review/review-artifact.ts";
import { COMMAND_PROFILES } from "../tools/command-profile.ts";
import { escalateLane, LANE_POLICY, readLane, type Lane } from "./lane.ts";
import {
  defaultDependencies,
  reviewChange,
  type ReviewChangeInput,
  type ReviewChangeResult,
  type ReviewControllerDependencies,
} from "./review.ts";

/** A request with this many concerns to answer is given this long before it counts as unavailable. */
const PLAN_LINT_DEADLINE_MS = 30_000;

export interface PlanReviewInput extends ReviewChangeInput {
  /** Where the lane record lives. */
  store: AtomicJsonStore;
  openSpec: Pick<OpenSpecAdapter, "validate">;
}

export interface LaneEscalation {
  readonly from: Lane;
  readonly to: Lane;
  readonly reason: string;
}

export type PlanReviewResult =
  | { readonly kind: "lint_failed"; readonly errors: readonly string[] }
  | {
    readonly kind: "lint_approved";
    readonly review: PlanningReviewArtifact;
    readonly reviewedPaths: readonly string[];
    readonly semanticCheck: "ran" | "unavailable" | "skipped";
  }
  | { readonly kind: "reviewed"; readonly result: ReviewChangeResult; readonly escalation?: LaneEscalation };

type Semantic =
  | { readonly status: "skipped" | "unavailable" | "uncertain" }
  | { readonly status: "ran"; readonly findings: readonly PlanLintFinding[]; readonly uncertain: number; readonly taskIds: readonly string[]; readonly concerns: number };

/**
 * Reviews a plan. Deterministic lint comes first, on every lane: a structural mistake ends the
 * command with the whole list, before any reviewer or judgment request. The small lane is then
 * approved by lint and one semantic check, and any doubt (a limit exceeded, a finding, an
 * uncertain concern) escalates the change to medium and runs the reviewer. Medium and large run
 * the reviewer, with the semantic check's findings as unverified notes.
 */
export async function reviewPlan(
  input: PlanReviewInput,
  overrides: Partial<ReviewControllerDependencies> = {},
): Promise<PlanReviewResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const { store, openSpec, ...reviewInput } = input;
  const judgment: JudgmentRuntime | undefined = input.judgment?.runtime;
  const { changeName, changeRoot } = input;
  let lane = (await readLane(store, changeName)).lane;

  const lint = await lintChange({ changeRoot, changeName, lane, profile: COMMAND_PROFILES.verification!, openSpec });
  if (lint.errors.length > 0) return { kind: "lint_failed", errors: lint.errors };

  let escalation: LaneEscalation | undefined;
  const escalate = async (reason: string): Promise<void> => {
    if (lane !== "small") return;
    await escalateLane(store, changeName, "medium", reason, dependencies.now);
    escalation = { from: lane, to: "medium", reason };
    lane = "medium";
  };
  if (lint.escalations.length > 0) await escalate(lint.escalations.join("; "));

  // The semantic check: asked once when the plan is small enough to ask about.
  let semantic: Semantic = { status: "unavailable" };
  let verdict: TriedVerdict<PlanLintGateValue> | null = null;
  const proposalText = await dependencies.readText(resolve(changeRoot, "proposal.md"));
  const state = lint.document
    ? buildPlanLintInput({ proposalText, requirements: lint.requirements, document: lint.document })
    : ({ ok: false, reason: "no_tasks" } as const);
  if (!state.ok) {
    semantic = { status: "skipped" };
    if (state.reason === "too_many_tasks") await escalate("the plan has more tasks than the semantic check is asked about");
  } else if (judgment?.enabled) {
    verdict = await tryJudge(judgment, planLintDecision, {
      input: state.input,
      changeName,
      phase: "planning",
      state: planLintState(state.input),
      signal: input.signal,
      deadlineMs: PLAN_LINT_DEADLINE_MS,
    });
    if (verdict?.kind === "enforce") {
      if (verdict.outcome.act) {
        const { findings, uncertain } = verdict.outcome.value;
        semantic = {
          status: "ran",
          findings,
          uncertain: uncertain.length,
          taskIds: state.taskIds,
          concerns: state.taskIds.length * 5 + 1,
        };
      } else {
        semantic = { status: "uncertain" };
      }
    }
  }
  if (lane === "small") {
    if (semantic.status === "ran" && semantic.findings.length > 0) {
      await escalate(`the semantic check reported ${semantic.findings.length} finding(s)`);
    } else if (semantic.status === "ran" && semantic.uncertain > 0) {
      await escalate(`the semantic check left ${semantic.uncertain} concern(s) uncertain`);
    } else if (semantic.status === "uncertain") {
      await escalate("the semantic check could not be read");
    }
  }

  if (lane === "small" && LANE_POLICY.small.planReview === "lint") {
    const artifacts = await dependencies.discoverArtifacts(input.repositoryRoot, changeRoot);
    const existing = await dependencies.readExistingReview(resolve(changeRoot, "review.md"));
    const semanticCheck = semantic.status === "ran" ? "ran" : semantic.status === "skipped" ? "skipped" : "unavailable";
    const review = createReviewArtifact({
      schemaVersion: 1,
      mode: "lint",
      round: (existing?.round ?? 0) + 1,
      reviewedAt: dependencies.now().toISOString(),
      model: "lint",
      artifactDigest: await dependencies.hashArtifacts(artifacts),
      requestedVerdict: "APPROVE",
      criticalFindings: [],
      requiredChanges: [],
      recommendations: [],
      lint: {
        checks: [...lint.checks],
        semanticCheck,
        answers: semantic.status === "ran"
          ? [`${semantic.concerns} concern(s) judged clean with confidence`]
          : verdict?.kind === "shadow"
            ? ["the semantic check ran in shadow mode and was not used"]
            : [],
      },
    });
    await dependencies.writeReview(resolve(changeRoot, "review.md"), review);
    await verdict?.reconcile({ approvedBy: "lint" });
    return { kind: "lint_approved", review, reviewedPaths: artifacts.map((artifact) => artifact.relativePath), semanticCheck };
  }

  const notes = semantic.status === "ran" ? presentPlanLintFindings(semantic.findings, semantic.taskIds).lines : [];
  const result = await reviewChange({ ...reviewInput, planLintNotes: notes }, overrides);
  await verdict?.reconcile({ approvedBy: "reviewer", escalated: escalation !== undefined });
  return { kind: "reviewed", result, ...(escalation ? { escalation } : {}) };
}
