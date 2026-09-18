import { resolve } from "node:path";
import type { ModelStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import { resolveChildRuntime } from "../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyReadOnlyChild } from "../agents/legacy-adapter.ts";
import { reviewChange } from "../controller/review.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createChangeUsageStore, recordChangeUsage } from "../persistence/change-usage-store.ts";
import { runBrokeredPlanningReviewer } from "../review/planning-reviewer.ts";
import { usageFromLegacyRun } from "../telemetry/usage.ts";
import type { AgentRunObserver } from "../runtime/agent-progress.ts";
import type { ParsedChangeCommand, ChangeCommandContext } from "../runtime/change-command.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "../runtime/command.ts";
import { createCommandRunId } from "../runtime/command.ts";
import { resolveProductionModelStack } from "../runtime/planning.ts";

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
}

export async function runProductionReview(options: ProductionReviewOptions): Promise<CommandOutcome> {
  const adapter = options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal });
  const status = await adapter.status(options.changeName);
  const stack = options.modelStack ?? resolveProductionModelStack(options.argv);
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
  }, options.now ? { now: options.now } : {});

  const approved = result.review.verdict === "APPROVE";
  return {
    status: approved ? "success" : "blocked",
    action: "review",
    changeName: options.changeName,
    runId,
    summary: approved
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

/** Builds the `/change review` handler bound to the given cwd/options closure. */
export function createReviewHandler(cwd: string, options: ProductionRuntimeOptions) {
  return async function reviewHandler(
    command: ParsedChangeCommand & { changeName?: string },
    context: ChangeCommandContext,
  ): Promise<CommandOutcome | void> {
    return (options.runners?.review ?? runProductionReview)({
      onAgentStart: context.onAgentStart ?? options.onAgentStart,
      cwd,
      changeName: command.changeName!,
      prompt: command.arguments.join(" ").trim() || undefined,
      signal: options.signal,
      argv: options.argv,
      runId: context.run?.runId,
    });
  };
}
