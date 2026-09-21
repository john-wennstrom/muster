import { resolve } from "node:path";
import type { ModelStack } from "../../agents/model-stack.ts";
import { resolveChildRuntime } from "../../agents/child-runtime.ts";
import { runAgent } from "../../agents/spawn.ts";
import { reviewPlan, type LaneEscalation } from "../../controller/plan-review.ts";
import { createJudgmentRuntime, type JudgmentRuntime } from "../../judgment/ask.ts";
import type { JudgmentEnvironment } from "../../judgment/policy.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import { createChangeUsageStore, recordChangeUsage } from "../../persistence/change-usage-store.ts";
import { runBrokeredPlanningReviewer } from "../../review/planning-reviewer.ts";
import { REVIEW_TRIAGE_MAX_CONSECUTIVE } from "../../review/review-triage.ts";
import { usageFromLegacyRun } from "../../telemetry/usage.ts";
import type { AgentRunObserver } from "../agent-progress.ts";
import type { CommandOutcome } from "../command.ts";
import { createCommandRunId } from "../command.ts";
import { resolveModelStack } from "../models.ts";

export interface ProductionReviewOptions {
  onAgentStart?: AgentRunObserver;
  cwd: string;
  changeName: string;
  prompt?: string;
  signal?: AbortSignal;
  argv?: readonly string[];
  openSpec?: OpenSpecAdapter;
  modelStack?: ModelStack;
  runId?: string;
  runner?: typeof runBrokeredPlanningReviewer;
  now?: () => Date;
  /** Replaces the runtime built from the environment, as tests do. */
  judgment?: JudgmentRuntime;
  /** The environment the enabling flags are read from; the process environment when absent. */
  env?: JudgmentEnvironment;
}

export async function runProductionReview(options: ProductionReviewOptions): Promise<CommandOutcome> {
  const adapter = options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal });
  const status = await adapter.status(options.changeName);
  const stack = options.modelStack ?? resolveModelStack(options.argv);
  const runId = options.runId ?? createCommandRunId("review", options.changeName);
  const store = createChangeUsageStore(options.cwd);
  const runner = options.runner ?? ((request) => runBrokeredPlanningReviewer(request, async (childOptions) => {
    try {
      childOptions.run.slot = stack.slots.find((slot) => slot.model === childOptions.run.model);
      return await runAgent({ ...childOptions, access: "read", modelStack: stack, onAgentStart: options.onAgentStart });
    } finally {
      await recordChangeUsage(store, options.changeName, [
        usageFromLegacyRun(runId, "planning", childOptions.run, "planning.review"),
      ]);
    }
  }));
  const env = options.env ?? process.env;
  const judgment = options.judgment ?? createJudgmentRuntime({ env, store });
  // Triage runs whenever judgment does. Without judgment no retention happens and every changed
  // artifact set gets a full review.
  const review = await reviewPlan({
    repositoryRoot: resolve(options.cwd),
    changeRoot: resolve(status.changeRoot),
    changeName: options.changeName,
    runId,
    sessionsRoot: resolve(options.cwd, ".fusion", "runs", runId, "sessions"),
    author: { model: stack.architect.model },
    candidates: stack.slots.map((slot) => ({ model: slot.model, available: true, readTools: resolveChildRuntime(stack, slot, "read").tools })),
    prompt: options.prompt,
    signal: options.signal,
    runner,
    store,
    openSpec: adapter,
    judgment: { runtime: judgment, store },
    ...(judgment.enabled ? { triage: { runtime: judgment, store } } : {}),
  }, options.now ? { now: options.now } : {});

  const base = { action: "review" as const, changeName: options.changeName, runId };
  if (review.kind === "lint_failed") {
    return {
      ...base,
      status: "blocked",
      summary: `Plan lint failed with ${review.errors.length} problem(s), so no reviewer ran and no judgment request was made:\n${review.errors.map((error) => `- ${error}`).join("\n")}`,
      next: `/change refine ${options.changeName}`,
      blocker: { kind: "invalid_evidence", message: review.errors.join("; "), artifact: "tasks.md" },
    };
  }
  if (review.kind === "lint_approved") {
    return {
      ...base,
      status: "success",
      summary: `Plan approved by lint for ${review.reviewedPaths.length} artifact(s): the change is on the small lane, so no reviewer ran. ` +
        (review.semanticCheck === "ran" ? "The semantic check found nothing." : `The semantic check did not run (${review.semanticCheck}), and review.md says so.`),
      next: `/change implement ${options.changeName}`,
    };
  }
  const { result, escalation } = review;
  const approved = result.review.verdict === "APPROVE";
  const carried = result.review.carriedForward;
  return {
    ...base,
    status: approved ? "success" : "blocked",
    summary: `${escalationNote(escalation)}${carried
      ? `Planning review APPROVE carried forward for ${result.reviewedPaths.length} artifact(s): no reviewer ran, because only the proposal or design prose changed and the change was judged immaterial. ` +
        `It stands on the full review of digest ${carried.basisDigest.slice(0, 12)} (carry-forward ${carried.count} of ${REVIEW_TRIAGE_MAX_CONSECUTIVE}). ` +
        `For a full review, give the review command instructions: /change review ${options.changeName} <what to check>.`
      : approved
      ? `Planning review APPROVE persisted for ${result.reviewedPaths.length} artifact(s).`
      : `Planning review REVISE persisted with ${result.review.requiredChanges.length} required change(s).`}`,
    next: `/change ${result.nextAction} ${options.changeName}`,
    blocker: approved ? undefined : {
      kind: "invalid_evidence",
      message: result.review.requiredChanges.join("; ") || "Planning review requires revision",
      artifact: "review.md",
    },
  };
}

/** Says so when this review moved the change up a lane, and why. */
function escalationNote(escalation: LaneEscalation | undefined): string {
  return escalation
    ? `The change was escalated from the ${escalation.from} lane to ${escalation.to}: ${escalation.reason}. A reviewer ran. `
    : "";
}
