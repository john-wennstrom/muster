import type { RecoveryAction, RecoveryPlan } from "../controller/recovery.ts";
import {
  runChangeScheduler,
  type ChangeSchedulerOptions,
  type ChangeSchedulerResult,
} from "./scheduler.ts";

export interface ImplementationFlowOptions {
  reviewFreshness: "missing" | "current" | "stale";
  recovery: RecoveryPlan;
  executeRecoveryAction: (action: RecoveryAction) => Promise<void>;
  scheduler: ChangeSchedulerOptions;
  onDesignConflict: (taskIds: readonly string[]) => Promise<void> | void;
}

export interface ImplementationFlowResult {
  status: "completed" | "blocked" | "paused" | "review_required" | "design_conflict";
  scheduler?: ChangeSchedulerResult;
  recoveryActions: readonly RecoveryAction[];
}

const recoveryOnlyActions = new Set<RecoveryAction["type"]>([
  "restore_checkpoint",
  "wait_for_child",
  "wait_for_live_lease",
  "review_existing_changes",
  "resume_task_review",
  "synchronize_task_completion",
  "synchronize_runtime_completion",
  "resume_final_verification",
]);

export async function runImplementationFlow(
  options: ImplementationFlowOptions,
): Promise<ImplementationFlowResult> {
  for (const action of options.recovery.actions) {
    await options.executeRecoveryAction(action);
  }
  if (
    options.reviewFreshness !== "current" ||
    options.recovery.actions.some((action) => action.type === "invalidate_run")
  ) {
    return {
      status: "review_required",
      recoveryActions: [...options.recovery.actions],
    };
  }
  if (options.recovery.actions.some((action) => recoveryOnlyActions.has(action.type))) {
    return {
      status: "paused",
      recoveryActions: [...options.recovery.actions],
    };
  }

  const scheduler = await runChangeScheduler(options.scheduler);
  const conflicts = scheduler.worktree
    ? Object.entries(scheduler.states)
      .filter(([, state]) => state === "design_conflict")
      .map(([taskId]) => taskId)
    : [];
  if (conflicts.length > 0) {
    await options.onDesignConflict(conflicts);
    return {
      status: "design_conflict",
      scheduler,
      recoveryActions: [...options.recovery.actions],
    };
  }
  const states = Object.values(scheduler.states);
  const status = states.every((state) => state === "completed")
    ? "completed"
    : states.some((state) => state === "awaiting_user")
      ? "paused"
      : "blocked";
  return {
    status,
    scheduler,
    recoveryActions: [...options.recovery.actions],
  };
}