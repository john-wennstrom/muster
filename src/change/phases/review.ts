import { resolve } from "node:path";
import type { ModelStack } from "../../../extensions/fusion-harness/modules/model-stack.ts";
import { resolveChildRuntime } from "../../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyReadOnlyChild } from "../../agents/legacy-adapter.ts";
import { reviewChange } from "../../controller/review.ts";
import { currentTaskQualityNotes } from "../../controller/task-quality.ts";
import { createJudgmentRuntime, type JudgmentRuntime } from "../../judgment/ask.ts";
import { REVIEW_TRIAGE_ENABLE_VARIABLE } from "../../judgment/gates.ts";
import type { JudgmentEnvironment } from "../../judgment/policy.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import { createChangeUsageStore, recordChangeUsage } from "../../persistence/change-usage-store.ts";
import { runBrokeredPlanningReviewer } from "../../review/planning-reviewer.ts";
import { REVIEW_TRIAGE_MAX_CONSECUTIVE } from "../../review/review-triage.ts";
import { readFileOrNull } from "../../shared/fs.ts";
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
      return await runLegacyReadOnlyChild({ ...childOptions, modelStack: stack, onAgentStart: options.onAgentStart });
    } finally {
      await recordChangeUsage(store, options.changeName, [
        usageFromLegacyRun(runId, "planning", childOptions.run, "planning.review"),
      ]);
    }
  }));
  const env = options.env ?? process.env;
  const judgment = options.judgment ?? createJudgmentRuntime({ env, store });
  // Review triage has its own flag on top of judgment. Without both, no retention happens and
  // every changed artifact set gets a full review.
  const triageEnabled = judgment.enabled && env[REVIEW_TRIAGE_ENABLE_VARIABLE]?.trim() === "1";
  // Plan-time findings are advice for the reviewer, who remains the only author of the review.
  // With judgment disabled nothing is read, so the prompt is what it is without judgment.
  const tasksContents = judgment.enabled ? await readFileOrNull(resolve(status.changeRoot, "tasks.md")) : null;
  const taskQualityNotes = tasksContents === null
    ? []
    : await currentTaskQualityNotes({ store, changeName: options.changeName, tasksContents });
  const result = await reviewChange({
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
    judgment: { runtime: judgment, store },
    taskQualityNotes,
    ...(triageEnabled ? { triage: { runtime: judgment, store } } : {}),
  }, options.now ? { now: options.now } : {});

  const approved = result.review.verdict === "APPROVE";
  const carried = result.review.carriedForward;
  return {
    status: approved ? "success" : "blocked",
    action: "review",
    changeName: options.changeName,
    runId,
    summary: carried
      ? `Planning review APPROVE carried forward for ${result.reviewedPaths.length} artifact(s): no reviewer ran, because only the proposal or design prose changed and the change was judged immaterial. ` +
        `It stands on the full review of digest ${carried.basisDigest.slice(0, 12)} (carry-forward ${carried.count} of ${REVIEW_TRIAGE_MAX_CONSECUTIVE}). ` +
        `For a full review, give the review command instructions: /change review ${options.changeName} <what to check>.`
      : approved
      ? `Planning review APPROVE persisted for ${result.reviewedPaths.length} artifact(s).`
      : `Planning review REVISE persisted with ${result.review.requiredChanges.length} required change(s).`,
    next: `/change ${result.nextAction} ${options.changeName}`,
    blocker: approved ? undefined : {
      kind: "invalid_evidence",
      message: result.review.requiredChanges.join("; ") || "Planning review requires revision",
      artifact: "review.md",
    },
  };
}
