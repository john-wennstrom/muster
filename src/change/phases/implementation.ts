import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { implementChange, resumeChange } from "../../controller/implement.ts";
import type { RecoveryPlan } from "../../controller/recovery.ts";
import { compileTaskDag, persistTaskDag } from "../../execution/delegation-dag.ts";
import { GitAdapter } from "../../execution/git.ts";
import { loadValidatedTaskDocument } from "../../execution/load-tasks.ts";
import type { RecoveryEnd } from "../../execution/failed-attempt.ts";
import { RunManifestKeeper } from "../../execution/run-manifest.ts";
import type { ChangeTaskExecutionContext } from "../../execution/scheduler.ts";
import type { ValidatedTask } from "../../execution/task-schema.ts";
import type {
  TaskPipelineBuilderResult,
  TaskPipelineReviewResult,
  TaskPipelineVerificationResult,
} from "../../execution/task-runner.ts";
import { createUnitRunner, type UnitSteps } from "../../execution/unit-runner.ts";
import { ensureChangeWorktree, type ChangeWorktree } from "../../execution/worktree.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import { createJudgmentRuntime, type JudgmentRuntime } from "../../judgment/ask.ts";
import { openChangeRun } from "../../persistence/run-store.ts";
import { checkpointRecordSchema } from "../../persistence/records.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../../review/artifact-digest.ts";
import type { CommandOutcome } from "../command.ts";
import type { AgentRunObserver } from "../agent-progress.ts";
import { economyBuilderSlot, economyReviewerSlot, resolveModelStack, roleModel } from "../models.ts";
import type { TaskStepContext } from "./task-steps/context.ts";
import { runBuilderStep } from "./task-steps/builder.ts";
import { runVerificationStep } from "./task-steps/verification.ts";
import { runReviewStep } from "./task-steps/review.ts";

/** The scheduler runs a task at most this many times. */
const MAX_TASK_ATTEMPTS = 2;

export interface ProductionTaskExecutionPorts {
  runBuilder?(
    task: ValidatedTask,
    context: ChangeTaskExecutionContext,
    signal?: AbortSignal,
    /** One-based; only a first attempt may be routed to the economy lane. */
    attempt?: number,
  ): Promise<TaskPipelineBuilderResult>;
  runVerification?(task: ValidatedTask, context: ChangeTaskExecutionContext, signal?: AbortSignal): Promise<TaskPipelineVerificationResult>;
  runReview?(
    task: ValidatedTask,
    builder: TaskPipelineBuilderResult,
    verification: TaskPipelineVerificationResult,
    context: ChangeTaskExecutionContext,
    signal?: AbortSignal,
  ): Promise<TaskPipelineReviewResult>;
  selectWorktree?: typeof ensureChangeWorktree;
}

export interface ProductionImplementationOptions {
  onAgentStart?: AgentRunObserver;
  cwd: string;
  changeName: string;
  reviewFreshness: "missing" | "current" | "stale";
  signal?: AbortSignal;
  argv?: readonly string[];
  checkpointId?: string;
  confirmedBy?: string;
  openSpec?: OpenSpecAdapter;
  ports?: ProductionTaskExecutionPorts;
  now?: () => Date;
  /** Replaces the runtime built from the environment, as tests do. */
  judgment?: JudgmentRuntime;
}

export async function runProductionImplementation(
  options: ProductionImplementationOptions,
): Promise<CommandOutcome> {
  const adapter = options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal });
  const [status, apply] = await Promise.all([
    adapter.status(options.changeName),
    adapter.applyInstructions(options.changeName),
  ]);
  const tasksPath = status.artifactPaths.tasks?.existingOutputPaths[0] ?? resolve(status.changeRoot, "tasks.md");
  const artifactDigest = await hashReviewedArtifacts(
    await discoverReviewedArtifacts(options.cwd, resolve(status.changeRoot)),
  );
  const { contents: tasksContents, document } = await loadValidatedTaskDocument(tasksPath);
  const tasksDigest = createHash("sha256").update(tasksContents, "utf8").digest("hex");
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const dag = compileTaskDag(document.tasks.map((task) => ({
    id: task.id,
    dependsOn: task.dependsOn,
    checked: task.checked,
  })), tasksDigest, timestamp);
  const changeRun = openChangeRun(options.cwd, options.changeName);
  const { runId, store } = changeRun;
  await persistTaskDag(store, runId, dag);

  const planningGit = new GitAdapter(options.cwd, undefined, undefined, options.signal);
  const planningIdentity = await planningGit.identity();
  const selectWorktree = options.ports?.selectWorktree ?? ensureChangeWorktree;
  const selectedWorktree = await selectWorktree({
    planningCwd: options.cwd,
    changeName: options.changeName,
    worktreesRoot: resolve(planningIdentity.root, "..", ".muster-worktrees", basename(planningIdentity.root)),
    signal: options.signal,
  });
  const worktreeGit = new GitAdapter(selectedWorktree.path, undefined, undefined, options.signal);
  const [head, gitStatus, diff] = await Promise.all([
    worktreeGit.head(),
    worktreeGit.status(),
    worktreeGit.diff(),
  ]);
  const stack = resolveModelStack(options.argv);
  const stepContext: TaskStepContext = {
    runId,
    changeName: options.changeName,
    planningCwd: options.cwd,
    store,
    stack,
    onAgentStart: options.onAgentStart,
    judgment: options.judgment ?? createJudgmentRuntime({ env: process.env, store }),
    economyBuilder: economyBuilderSlot(stack),
    economyReviewer: economyReviewerSlot(stack),
    routing: new Map(),
  };
  const now = options.now ?? (() => new Date());
  const keeper = await RunManifestKeeper.open({
    store,
    runId,
    changeName: options.changeName,
    worktree: selectedWorktree,
    artifactDigest,
    document,
    creation: {
      head: head.commit,
      gitStatus,
      diff,
      modelAssignments: {
        architect: roleModel(stack, "architect"),
        builder: roleModel(stack, "builder"),
        reviewer: roleModel(stack, "reviewer"),
        validator: roleModel(stack, "validator"),
      },
    },
    now,
  });

  const checkpoints = await changeRun.readRecords("checkpoints", checkpointRecordSchema);
  const pendingCheckpoints = checkpoints.filter((checkpoint) => checkpoint.status === "pending");
  const recovery: RecoveryPlan = {
    actions: keeper.artifactChanged
      ? [{ type: "invalidate_run" as const, reason: "artifact_digest_changed" as const }]
      : pendingCheckpoints.map((checkpoint) => ({
        type: "restore_checkpoint" as const,
        taskId: checkpoint.taskId,
        checkpointId: checkpoint.id,
      })),
    discrepancies: [],
  };
  const state = { contents: tasksContents };
  const recoveryEnds: RecoveryEnd[] = [];
  const steps: UnitSteps = {
    runBuilder: (task, context, signal, attempt) => options.ports?.runBuilder
      ? options.ports.runBuilder(task, context, signal, attempt)
      : runBuilderStep(stepContext, task, context, signal, undefined, attempt),
    runVerification: (task, context, signal) => options.ports?.runVerification
      ? options.ports.runVerification(task, context, signal)
      : runVerificationStep(task, context.worktree.path, signal),
    runReview: (task, builder, verification, context, signal) => options.ports?.runReview
      ? options.ports.runReview(task, builder, verification, context, signal)
      : runReviewStep(stepContext, task, context, builder, verification, signal),
  };
  const execute = createUnitRunner({
    runId,
    changeName: options.changeName,
    planningCwd: options.cwd,
    store,
    changeRun,
    dag,
    document,
    tasksPath,
    state,
    keeper,
    pendingCheckpoints,
    steps,
    fallbackReviewerModel: stack.architect.model,
    now,
    judgment: stepContext.judgment,
    maxAttempts: MAX_TASK_ATTEMPTS,
    recoveryEnds,
  });

  const scheduler = {
    runId,
    dag,
    tasks: Object.fromEntries(document.tasks.map((task) => [task.id, {
      mode: task.writes.length > 0 ? "write" as const : "read" as const,
      maxAttempts: MAX_TASK_ATTEMPTS,
    }])),
    pendingCheckpoints,
    worktree: {
      planningCwd: options.cwd,
      changeName: options.changeName,
      worktreesRoot: resolve(selectedWorktree.path, ".."),
      recordedPath: selectedWorktree.path,
      signal: options.signal,
    },
    selectWorktree: async (): Promise<ChangeWorktree> => selectedWorktree,
    signal: options.signal,
    execute,
  };

  const flow = {
    reviewFreshness: options.reviewFreshness,
    recovery,
    executeRecoveryAction: async () => undefined,
    scheduler,
    onDesignConflict: async (taskIds: readonly string[]) => {
      for (const taskId of taskIds) await keeper.recordTask(taskId, "design_conflict", pendingCheckpoints.map((checkpoint) => checkpoint.id));
    },
  };
  const result = options.checkpointId
    ? (await resumeChange({
      changeName: options.changeName,
      checkpointId: options.checkpointId,
      confirmedBy: options.confirmedBy ?? "local-user",
      store,
      flow,
      now: options.now,
    })).implementation
    : await implementChange({ changeName: options.changeName, flow });

  // An escalated task is left ready rather than blocked, so the run records where it can resume.
  const schedulerStates: Record<string, string> = { ...result.scheduler?.states };
  for (const end of recoveryEnds) if (end.kind === "escalate") schedulerStates[end.taskId] = "ready";
  const cancelled = Object.values(schedulerStates).some((state) => state === "cancelled");
  if (result.scheduler) {
    await keeper.finish(
      cancelled
        ? "CANCELLED"
        : result.status === "completed"
          ? "VERIFYING"
          : result.status === "design_conflict"
            ? "DESIGN_CONFLICT"
            : result.status === "paused"
              ? "AWAITING_USER"
              : "BLOCKED",
      schedulerStates,
    );
  }
  const recoveryEnd = recoveryEnds.at(-1);
  const terminalStatus = cancelled
    ? "cancelled" as const
    : result.status === "completed"
      ? "success" as const
      : result.status === "review_required" || result.status === "paused" || result.status === "blocked" || result.status === "design_conflict"
        ? "blocked" as const
        : "failure" as const;
  const pendingIds = (await changeRun.readRecords("checkpoints", checkpointRecordSchema))
    .filter((checkpoint) => checkpoint.status === "pending")
    .map((checkpoint) => checkpoint.id);
  return {
    status: terminalStatus,
    action: options.checkpointId ? "resume" : "implement",
    changeName: options.changeName,
    runId,
    summary: recoveryEnd
      ? recoveryEnd.kind === "escalate"
        ? `Implementation blocked: task ${recoveryEnd.taskId} showed the change is larger than planned, so it moved to the ${recoveryEnd.lane} lane (${recoveryEnd.reason}).`
        : `Implementation blocked: task ${recoveryEnd.taskId} needs a person (${recoveryEnd.reason}); the failure is recorded at ${recoveryEnd.failurePath}.`
      : `Implementation ${cancelled ? "cancelled" : result.status}${pendingIds.length ? `; pending checkpoint(s): ${pendingIds.join(", ")}` : ""}.`,
    next: cancelled
      ? `/change status ${options.changeName}`
      : recoveryEnd?.kind === "escalate"
      ? `/change review ${options.changeName}`
      : result.status === "completed"
      ? `/change verify ${options.changeName}`
      : result.status === "review_required"
        ? `/change review ${options.changeName}`
        : pendingIds[0]
          ? `/change resume ${options.changeName} ${pendingIds[0]}`
          : `/change status ${options.changeName}`,
    blocker: terminalStatus === "blocked" ? {
      kind: pendingIds.length ? "pending_checkpoint" : result.status === "review_required" ? "stale_digest" : "lifecycle",
      message: `Implementation ${result.status}`,
      checkpointIds: pendingIds,
    } : undefined,
  };
}
