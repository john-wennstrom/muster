import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createDependencyReport } from "../../agents/reports.ts";
import { implementChange, resumeChange } from "../../controller/implement.ts";
import { checkpointPlannedManualAction } from "../../controller/manual-checkpoint.ts";
import { reconcileTaskQualityOutcome } from "../../controller/task-quality.ts";
import type { RecoveryPlan } from "../../controller/recovery.ts";
import { compileTaskDag, persistTaskDag } from "../../execution/delegation-dag.ts";
import { computeDiffDigest, computeIndexDigest, readSourceDigest } from "../../execution/change-digests.ts";
import { GitAdapter } from "../../execution/git.ts";
import { loadValidatedTaskDocument } from "../../execution/load-tasks.ts";
import { affectedTaskBranch, type ChangeTaskExecutionContext } from "../../execution/scheduler.ts";
import type { ValidatedTask } from "../../execution/task-schema.ts";
import {
  runTaskPipeline,
  type TaskPipelineBuilderResult,
  type TaskPipelineReviewResult,
  type TaskPipelineVerificationResult,
} from "../../execution/task-runner.ts";
import { ensureChangeWorktree, type ChangeWorktree } from "../../execution/worktree.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import { createJudgmentRuntime, type JudgmentRuntime } from "../../judgment/ask.ts";
import { listDecisionRecords, reconcileDecisionRecord } from "../../judgment/audit.ts";
import { modelRoutingDecision } from "../../judgment/gates.ts";
import type { AtomicJsonStore } from "../../persistence/atomic-json-store.ts";
import { openChangeRun } from "../../persistence/run-store.ts";
import {
  checkpointRecordSchema,
  reviewRecordSchema,
  runManifestSchema,
  taskResultSchema,
  type RunManifest,
} from "../../persistence/records.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../../review/artifact-digest.ts";
import { HarnessError } from "../../shared/errors.ts";
import type { CommandOutcome } from "../command.ts";
import type { AgentRunObserver } from "../agent-progress.ts";
import { economyBuilderSlot, resolveModelStack, roleModel } from "../models.ts";
import type { TaskStepContext } from "./task-steps/context.ts";
import { runBuilderStep } from "./task-steps/builder.ts";
import { runVerificationStep } from "./task-steps/verification.ts";
import { runReviewStep } from "./task-steps/review.ts";

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

/**
 * Measurement only: merges a task's first-attempt outcome into the routing record that attempt
 * wrote, along with the lane it actually ran on. The lane is read off the record: it was the
 * economy lane only when the gate's acting outcome was handed to the builder step, which is
 * enforce mode. A record from before `since` belongs to an earlier run and is left alone, as is
 * one that already holds an outcome, so a later attempt never overwrites the first. A missing
 * record is normal, since routing is usually off, and a failure here must not fail the task.
 */
async function reconcileTaskRoutingOutcome(input: {
  store: AtomicJsonStore;
  changeName: string;
  taskId: string;
  status: string;
  since: string;
}): Promise<void> {
  try {
    const records = (await listDecisionRecords(input.store, input.changeName))
      .filter((record) =>
        record.decision === modelRoutingDecision.id &&
        record.taskId === input.taskId &&
        record.createdAt >= input.since)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const latest = records.at(-1);
    if (!latest || latest.observed.outcome !== undefined) return;
    await reconcileDecisionRecord(input.store, input.changeName, latest.recordId, {
      observed: { lane: latest.acted ? "economy" : "primary", outcome: input.status },
    });
  } catch {
    // Reconciliation is measurement; the task's own outcome stands without it.
  }
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
  };
  let manifest: RunManifest;
  let artifactChanged = false;
  try {
    manifest = runManifestSchema.parse(await store.read(runId, "manifest.json"));
    if (
      manifest.changeName !== options.changeName ||
      manifest.repository.id !== selectedWorktree.repositoryId ||
      resolve(manifest.worktree.path) !== resolve(selectedWorktree.path)
    ) {
      throw new HarnessError("RECOVERY_STATE_CONFLICT", "Persisted implementation identity does not match the selected change worktree", {
        runId,
        changeName: options.changeName,
      });
    }
    artifactChanged = manifest.artifactDigest !== artifactDigest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    manifest = runManifestSchema.parse({
      schemaVersion: 1,
      runId,
      changeName: options.changeName,
      lifecycle: "READY",
      repository: { id: selectedWorktree.repositoryId, commonDirectory: selectedWorktree.commonDirectory },
      worktree: {
        path: selectedWorktree.path,
        head: head.commit,
        indexDigest: computeIndexDigest(gitStatus),
        diffDigest: computeDiffDigest(diff),
      },
      artifactDigest,
      tasks: Object.fromEntries(document.tasks.map((task) => [task.id, task.checked ? "completed" : "ready"])),
      modelAssignments: {
        architect: roleModel(stack, "architect"),
        builder: roleModel(stack, "builder"),
        reviewer: roleModel(stack, "reviewer"),
        validator: roleModel(stack, "validator"),
      },
      writer: null,
      checkpoints: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.write(runId, "manifest.json", manifest);
  }

  const checkpoints = await changeRun.readRecords("checkpoints", checkpointRecordSchema);
  const pendingCheckpoints = checkpoints.filter((checkpoint) => checkpoint.status === "pending");
  const recovery: RecoveryPlan = {
    actions: artifactChanged
      ? [{ type: "invalidate_run" as const, reason: "artifact_digest_changed" as const }]
      : pendingCheckpoints.map((checkpoint) => ({
        type: "restore_checkpoint" as const,
        taskId: checkpoint.taskId,
        checkpointId: checkpoint.id,
      })),
    discrepancies: [],
  };
  let currentContents = tasksContents;

  const persistManifest = async (taskId: string, state: RunManifest["tasks"][string]): Promise<void> => {
    manifest = runManifestSchema.parse({
      ...manifest,
      lifecycle: state === "awaiting_user" ? "AWAITING_USER" : state === "design_conflict" ? "DESIGN_CONFLICT" : "IMPLEMENTING",
      tasks: { ...manifest.tasks, [taskId]: state },
      checkpoints: [...new Set([...manifest.checkpoints, ...pendingCheckpoints.map((checkpoint) => checkpoint.id)])],
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    await store.write(runId, "manifest.json", manifest);
  };

  const scheduler = {
    runId,
    dag,
    tasks: Object.fromEntries(document.tasks.map((task) => [task.id, {
      mode: task.writes.length > 0 ? "write" as const : "read" as const,
      maxAttempts: 2,
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
    execute: async (
      scheduledTask: { id: string },
      attempt: number,
      context: ChangeTaskExecutionContext,
      signal?: AbortSignal,
    ) => {
      const task = document.tasks.find((candidate) => candidate.id === scheduledTask.id)!;
      if (task.manual) {
        const checkpoint = await checkpointPlannedManualAction({
          store,
          runId,
          changeName: options.changeName,
          taskId: task.id,
          branch: affectedTaskBranch(dag, task.id),
          manual: task.manual,
        });
        pendingCheckpoints.push(checkpoint);
        await persistManifest(task.id, "awaiting_user");
        return { outcome: "awaiting_user" as const };
      }

      // Measurement only: the first attempt's outcome, against whether plan time flagged the task
      // and against the lane it ran on. An attempt that throws is a first attempt that did not
      // complete, so it is recorded too.
      const attemptStartedAt = new Date().toISOString();
      const recordFirstAttemptOutcome = async (status: string): Promise<void> => {
        if (attempt !== 1) return;
        await Promise.all([
          reconcileTaskQualityOutcome({
            store,
            changeName: options.changeName,
            tasks: document.tasks,
            taskId: task.id,
            status,
          }),
          reconcileTaskRoutingOutcome({
            store,
            changeName: options.changeName,
            taskId: task.id,
            status,
            since: attemptStartedAt,
          }),
        ]);
      };
      let verificationEvidence: readonly string[] = [];
      let reviewFindings: readonly string[] = [];
      const pipeline = await runTaskPipeline({
        runId,
        sessionsRoot: resolve(options.cwd, ".fusion", "runs", runId, "sessions"),
        contents: currentContents,
        task: {
          ...task,
          metadata: {
            id: task.id,
            dependsOn: task.dependsOn,
            role: task.role,
            reads: task.reads,
            writes: task.writes,
            requirements: task.requirements,
            scenarios: task.scenarios,
            verify: task.verify,
            manual: task.manual,
          },
        },
        behaviorChanging: true,
        requirements: task.requirements,
        scenarios: task.scenarios,
        reviewBudgetAvailable: true,
        runBuilder: () => (options.ports?.runBuilder
          ? options.ports.runBuilder(task, context, signal, attempt)
          : runBuilderStep(stepContext, task, context, signal, undefined, attempt)),
        runVerification: async () => {
          const result = options.ports?.runVerification
            ? await options.ports.runVerification(task, context, signal)
            : await runVerificationStep(task, context.worktree.path, signal);
          verificationEvidence = result.evidence;
          return result;
        },
        runReview: async ({ builder, verification }) => {
          const result = options.ports?.runReview
            ? await options.ports.runReview(task, builder, verification, context, signal)
            : await runReviewStep(stepContext, task, context, builder, verification, signal);
          reviewFindings = result.findings;
          return result;
        },
        persistEvidence: async ({ builder }) => {
          const evidenceGit = new GitAdapter(context.worktree.path, undefined, undefined, signal);
          const { sourceDigest } = await readSourceDigest(evidenceGit);
          await store.write(runId, `task-results/${task.id}.json`, taskResultSchema.parse({
            schemaVersion: 1,
            runId,
            taskId: task.id,
            outcome: "completed",
            sourceDigest,
            verificationEvidence,
            completedAt: (options.now ?? (() => new Date()))().toISOString(),
          }));
          await store.write(runId, `reviews/task-${task.id}.json`, reviewRecordSchema.parse({
            schemaVersion: 1,
            runId,
            taskId: task.id,
            kind: "task",
            verdict: reviewFindings.length > 0 ? "REVISE" : "APPROVE",
            artifactDigest: sourceDigest,
            model: manifest.modelAssignments.reviewer ?? stack.architect.model,
            findings: reviewFindings,
            createdAt: (options.now ?? (() => new Date()))().toISOString(),
          }));
          if (builder.tddEvidence) await store.write(runId, `tdd/${task.id}.json`, builder.tddEvidence);
          await store.write(runId, `reports/${task.id}.json`, createDependencyReport({
            schemaVersion: 1,
            runId,
            taskId: task.id,
            outcome: "completed",
            summary: task.description,
            changedInterfaces: [],
            evidence: [...verificationEvidence],
            createdAt: (options.now ?? (() => new Date()))().toISOString(),
          }));
        },
      }).catch(async (error: unknown) => {
        await recordFirstAttemptOutcome("failed");
        throw error;
      });
      currentContents = pipeline.contents;
      await writeFile(tasksPath, currentContents, "utf8");
      await persistManifest(task.id, pipeline.outcome.status === "completed" ? "completed" : pipeline.outcome.status);
      await recordFirstAttemptOutcome(pipeline.outcome.status);
      return { outcome: pipeline.outcome.status, error: pipeline.outcome.reason };
    },
  };

  const flow = {
    reviewFreshness: options.reviewFreshness,
    recovery,
    executeRecoveryAction: async () => undefined,
    scheduler,
    onDesignConflict: async (taskIds: readonly string[]) => {
      for (const taskId of taskIds) await persistManifest(taskId, "design_conflict");
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

  const schedulerStates = result.scheduler?.states ?? {};
  const cancelled = Object.values(schedulerStates).some((state) => state === "cancelled");
  if (result.scheduler) {
    const lifecycle: RunManifest["lifecycle"] = cancelled
      ? "CANCELLED"
      : result.status === "completed"
        ? "VERIFYING"
        : result.status === "design_conflict"
          ? "DESIGN_CONFLICT"
          : result.status === "paused"
            ? "AWAITING_USER"
            : "BLOCKED";
    manifest = runManifestSchema.parse({
      ...manifest,
      lifecycle,
      tasks: { ...manifest.tasks, ...schedulerStates },
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    await store.write(runId, "manifest.json", manifest);
  }
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
    summary: `Implementation ${cancelled ? "cancelled" : result.status}${pendingIds.length ? `; pending checkpoint(s): ${pendingIds.join(", ")}` : ""}.`,
    next: cancelled
      ? `/change status ${options.changeName}`
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
