import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { newRun, runError, runOk, resolveChildRuntime } from "../../extensions/fusion-harness/modules/runtime.ts";
import type { CollaborationTask } from "../../extensions/fusion-harness/modules/collaboration-graph.ts";
import { runLegacyBrokeredChild, runLegacyReadOnlyChild } from "../agents/legacy-adapter.ts";
import { createDependencyReport } from "../agents/reports.ts";
import { implementChange, resumeChange } from "../controller/implement.ts";
import { checkpointPlannedManualAction } from "../controller/manual-checkpoint.ts";
import type { RecoveryPlan } from "../controller/recovery.ts";
import { compileTaskDag, persistTaskDag } from "../execution/delegation-dag.ts";
import { computeDiffDigest, computeIndexDigest, computeSourceDigest } from "../execution/change-digests.ts";
import { GitAdapter } from "../execution/git.ts";
import { affectedTaskBranch, type ChangeTaskExecutionContext } from "../execution/scheduler.ts";
import { parseTaskDocument } from "../execution/task-parser.ts";
import { validateTaskDocument, type ValidatedTask } from "../execution/task-schema.ts";
import {
  runTaskPipeline,
  type TaskPipelineBuilderResult,
  type TaskPipelineReviewResult,
  type TaskPipelineVerificationResult,
} from "../execution/task-runner.ts";
import { ensureChangeWorktree, type ChangeWorktree } from "../execution/worktree.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createChangeUsageStore, changeRunId, recordChangeUsage } from "../persistence/change-usage-store.ts";
import {
  checkpointRecordSchema,
  reviewRecordSchema,
  runManifestSchema,
  taskResultSchema,
  tddEvidenceRecordSchema,
  type CheckpointRecord,
  type RunManifest,
} from "../persistence/records.ts";
import { dispatchTaskCodeReview, taskCodeReviewSchema } from "../review/code-review.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../review/artifact-digest.ts";
import { HarnessError } from "../shared/errors.ts";
import { runHostCommand } from "../tools/host-runner.ts";
import { usageFromLegacyRun } from "../telemetry/usage.ts";
import type { CommandOutcome } from "./command-runtime.ts";
import type { AgentRunObserver } from "./agent-progress.ts";
import { resolveProductionModelStack } from "./planning-runtime.ts";

const builderResultSchema = z.object({
  claim: z.enum(["completed", "blocked", "design_conflict"]),
  implementationPersisted: z.boolean(),
  reason: z.string().optional(),
  conflict: z.object({
    evidence: z.array(z.string().min(1)).min(1),
    affectedArtifacts: z.array(z.string().min(1)).min(1),
    affectedTasks: z.array(z.string().min(1)).min(1),
    recommendation: z.string().optional(),
  }).optional(),
  tddEvidence: tddEvidenceRecordSchema.optional(),
}).strict();

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch (cause) {
    throw new HarnessError("TASK_OUTCOME_INVALID", `${label} did not return one JSON object`, {}, { cause });
  }
}

export function parseVerificationCommand(command: string): { executable: string; args: string[] } {
  const args: string[] = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/[;&|<>`]/.test(character)) {
      throw new HarnessError("TASK_OUTCOME_INVALID", "Verification commands cannot contain shell operators", { command });
    }
    if (/\s/.test(character)) {
      if (token) {
        args.push(token);
        token = "";
      }
    } else token += character;
  }
  if (quote) throw new HarnessError("TASK_OUTCOME_INVALID", "Verification command has an unclosed quote", { command });
  if (token) args.push(token);
  const executable = args.shift();
  if (!executable) throw new HarnessError("TASK_OUTCOME_INVALID", "Verification command is empty", { command });
  return { executable, args };
}

async function readRecords<T>(
  store: ReturnType<typeof createChangeUsageStore>,
  runId: string,
  directory: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const paths = await store.list(runId, directory);
  return Promise.all(paths.map(async (path) => schema.parse(await store.read(runId, path))));
}

function collaborationTask(task: ValidatedTask): CollaborationTask {
  return {
    id: task.id,
    assignee: task.role,
    description: task.description,
    depends_on: [...task.dependsOn],
    outputs: [],
    mode: task.writes.length > 0 ? "write" : "read",
    reads: [...task.reads],
    writes: [...task.writes],
  };
}

export interface ProductionTaskExecutionPorts {
  runBuilder?(task: ValidatedTask, context: ChangeTaskExecutionContext, signal?: AbortSignal): Promise<TaskPipelineBuilderResult>;
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
  const tasksContents = await readFile(tasksPath, "utf8");
  const parsed = parseTaskDocument(tasksContents, tasksPath);
  const referencedRequirements = new Set<string>();
  const referencedScenarios = new Set<string>();
  for (const task of parsed.tasks) {
    const metadata = task.metadata as { requirements?: unknown; scenarios?: unknown };
    if (Array.isArray(metadata.requirements)) for (const value of metadata.requirements) if (typeof value === "string") referencedRequirements.add(value);
    if (Array.isArray(metadata.scenarios)) for (const value of metadata.scenarios) if (typeof value === "string") referencedScenarios.add(value);
  }
  const document = validateTaskDocument(parsed, {
    requirements: referencedRequirements,
    scenarios: referencedScenarios,
  });
  const tasksDigest = createHash("sha256").update(tasksContents, "utf8").digest("hex");
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const dag = compileTaskDag(document.tasks.map((task) => ({
    id: task.id,
    dependsOn: task.dependsOn,
    checked: task.checked,
  })), tasksDigest, timestamp);
  const runId = changeRunId(options.changeName);
  const store = createChangeUsageStore(options.cwd);
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
  const stack = resolveProductionModelStack(options.argv);

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
        architect: stack.architect.model,
        builder: stack.primaryBuilder.model,
        reviewer: stack.builders.find((slot) => slot.model !== stack.primaryBuilder.model)?.model ?? stack.architect.model,
        validator: stack.architect.model,
      },
      writer: null,
      checkpoints: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.write(runId, "manifest.json", manifest);
  }

  const checkpoints = await readRecords(store, runId, "checkpoints", checkpointRecordSchema);
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
      _attempt: number,
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

      const defaultRunBuilder = async (): Promise<TaskPipelineBuilderResult> => {
        const slot = stack.primaryBuilder;
        const run = newRun("BUILDER", slot.model, slot);
        const childId = `builder-${task.id}-${randomUUID()}`;
        try {
          await runLegacyBrokeredChild({
            run,
            modelStack: stack,
            onAgentStart: options.onAgentStart,
            prompt: [
              `Implement task ${task.id}: ${task.description}`,
              `Requirements: ${JSON.stringify(task.requirements)}`,
              `Scenarios: ${JSON.stringify(task.scenarios)}`,
              `Verification: ${JSON.stringify(task.verify)}`,
              "Use the available tools and stay within the declared scopes.",
              "Return exactly one JSON TaskPipelineBuilderResult with claim, implementationPersisted, and any reason/conflict/tddEvidence. No markdown fence.",
            ].join("\n\n"),
            systemPrompt: slot.systemPrompt,
            appendSystemPrompts: slot.appendSystemPrompts,
            role: "builder",
            runId,
            childId,
            task: collaborationTask(task),
            existingWriterLease: context.writerLease?.record,
            thinking: slot.thinking,
            sessionDir: resolve(options.cwd, ".fusion", "runs", runId, "sessions", childId),
            cwd: context.worktree.path,
            timeoutMs: 8 * 60 * 60 * 1000,
            signal,
          });
        } finally {
          await recordChangeUsage(store, options.changeName, [
            usageFromLegacyRun(runId, "implementation", run, task.id),
          ]);
        }
        if (!runOk(run)) {
          return { claim: "blocked" as const, implementationPersisted: false, reason: runError(run) };
        }
        return builderResultSchema.parse(parseJson(run.text, `Builder for ${task.id}`));
      };

      const defaultRunVerification = async (): Promise<TaskPipelineVerificationResult> => {
        const evidence: string[] = [];
        for (const command of task.verify) {
          const parsedCommand = parseVerificationCommand(command);
          const result = await runHostCommand({
            worktreePath: context.worktree.path,
            request: {
              profile: "verification",
              executable: parsedCommand.executable,
              args: parsedCommand.args,
              cwd: context.worktree.path,
            },
            signal,
          });
          evidence.push(`${command}: exit ${result.exitCode}`);
          if (result.exitCode !== 0) return { passed: false, evidence };
        }
        return { passed: true, evidence };
      };

      const defaultRunReview = async (
        builder: TaskPipelineBuilderResult,
        verification: TaskPipelineVerificationResult,
      ): Promise<TaskPipelineReviewResult> => {
        const currentGit = new GitAdapter(context.worktree.path, undefined, undefined, signal);
        const currentHead = await currentGit.head();
        const currentDiff = await currentGit.diff();
        const sourceDigest = computeSourceDigest(currentHead.commit, currentDiff);
        const reviewResult = await dispatchTaskCodeReview({
          runId,
          taskId: task.id,
          cwd: context.worktree.path,
          sessionsRoot: resolve(options.cwd, ".fusion", "runs", runId, "sessions"),
          author: { model: stack.primaryBuilder.model },
          candidates: stack.slots.map((slot) => ({ model: slot.model, available: true, readTools: resolveChildRuntime(stack, slot, "read").tools })),
          contract: { definition: task.description, requirements: task.requirements, scenarios: task.scenarios },
          diff: { digest: sourceDigest, summary: currentDiff },
          tests: verification.evidence,
          scopes: { reads: task.reads, writes: task.writes, violations: [] },
          tddEvidence: builder.tddEvidence ?? null,
          runner: async (request) => {
            const run = newRun("REVIEWER", request.model, stack.slots.find((slot) => slot.model === request.model));
            try {
              await runLegacyReadOnlyChild({
                run,
                modelStack: stack,
                onAgentStart: options.onAgentStart,
                prompt: `${request.prompt}\n\nReturn exactly one JSON review object; no markdown fence.`,
                role: "reviewer",
                runId,
                childId: request.sessionId,
                taskId: task.id,
                description: `Review task ${task.id}`,
                assignee: "reviewer",
                thinking: "high",
                sessionDir: request.sessionDir,
                sessionId: request.sessionId,
                continueTaskSession: true,
                cwd: context.worktree.path,
                timeoutMs: 120_000,
                signal,
              });
            } finally {
              await recordChangeUsage(store, options.changeName, [
                usageFromLegacyRun(runId, "implementation", run, task.id),
              ]);
            }
            if (!runOk(run)) throw new HarnessError("REVIEW_ARTIFACT_INVALID", runError(run));
            return { review: taskCodeReviewSchema.parse(parseJson(run.text, `Reviewer for ${task.id}`)), toolNames: run.toolNames };
          },
        });
        return {
          approved: reviewResult.decision.status === "approved",
          findings: reviewResult.decision.status === "repair" ? reviewResult.decision.findings : [],
        };
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
        runBuilder: () => options.ports?.runBuilder
          ? options.ports.runBuilder(task, context, signal)
          : defaultRunBuilder(),
        runVerification: async (builder) => {
          const result = options.ports?.runVerification
            ? await options.ports.runVerification(task, context, signal)
            : await defaultRunVerification();
          verificationEvidence = result.evidence;
          return result;
        },
        runReview: async ({ builder, verification }) => {
          const result = options.ports?.runReview
            ? await options.ports.runReview(task, builder, verification, context, signal)
            : await defaultRunReview(builder, verification);
          reviewFindings = result.findings;
          return result;
        },
        persistEvidence: async ({ builder }) => {
          const evidenceGit = new GitAdapter(context.worktree.path, undefined, undefined, signal);
          const evidenceHead = await evidenceGit.head();
          const evidenceDiff = await evidenceGit.diff();
          const sourceDigest = computeSourceDigest(evidenceHead.commit, evidenceDiff);
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
      });
      currentContents = pipeline.contents;
      await writeFile(tasksPath, currentContents, "utf8");
      await persistManifest(task.id, pipeline.outcome.status === "completed" ? "completed" : pipeline.outcome.status);
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
  const pendingIds = (await readRecords(store, runId, "checkpoints", checkpointRecordSchema))
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
