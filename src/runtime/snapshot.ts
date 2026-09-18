import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRun } from "../../extensions/fusion-harness/modules/runtime.ts";
import { createChangeSnapshot, type ChangeSnapshot } from "../controller/change-snapshot.ts";
import {
  computeDiffDigest,
  computeIndexDigest,
  computeSourceDigest,
} from "../execution/change-digests.ts";
import { GitAdapter } from "../execution/git.ts";
import { parseTaskDocument } from "../execution/task-parser.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import {
  changeRunId,
  createChangeUsageStore,
  loadChangeUsageSummary,
  recordChangeUsage,
  setActiveChange,
  type ChangeUsageSummary,
} from "../persistence/change-usage-store.ts";
import type { CheckpointRecord, RunManifest } from "../persistence/records.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../review/artifact-digest.ts";
import { parseReviewArtifact } from "../review/review-artifact.ts";
import { parseVerificationArtifact } from "../review/verification-artifact.ts";
import { HarnessError } from "../shared/errors.ts";
import { usageFromLegacyRun, type UsagePhase } from "../telemetry/usage.ts";
import { resolveProductionChange, type ProductionRuntimeOptions } from "./command.ts";

const NO_ARTIFACTS_DIGEST = computeSourceDigest("no-reviewed-artifacts", "");

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadProductionChangeSnapshot(
  options: ProductionRuntimeOptions & { changeName: string },
): Promise<ChangeSnapshot | null> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date().toISOString());
  let resolvedChange;
  try {
    resolvedChange = await resolveProductionChange({
      planningHome: cwd,
      changeName: options.changeName,
    });
  } catch (error) {
    if (error instanceof HarnessError && error.code === "CHANGE_NOT_FOUND") return null;
    throw error;
  }
  const changeRoot = resolvedChange.changeRoot;
  const tasksPath = resolve(changeRoot, "tasks.md");
  if (!(await pathExists(tasksPath))) return null;

  const git = new GitAdapter(cwd, undefined, undefined, options.signal);
  const identity = await git.identity();
  const head = await git.head();
  const statusEntries = await git.status();
  const diffText = await git.diff();

  const tasksContents = await readFile(tasksPath, "utf8");
  const parsedTasks = parseTaskDocument(tasksContents, tasksPath);
  const tasks = Object.fromEntries(
    parsedTasks.tasks.map((task) => [task.checkboxId, task.checked]),
  );

  let planningComplete = false;
  try {
    const status = await new OpenSpecAdapter({ cwd, signal: options.signal }).status(options.changeName);
    planningComplete = status.isPlanningComplete;
  } catch {
    planningComplete = false;
  }

  let artifactDigest = NO_ARTIFACTS_DIGEST;
  try {
    const artifacts = await discoverReviewedArtifacts(identity.root, changeRoot);
    artifactDigest = await hashReviewedArtifacts(artifacts);
  } catch {
    artifactDigest = NO_ARTIFACTS_DIGEST;
  }

  const runId = changeRunId(options.changeName);
  const store = createChangeUsageStore(cwd);
  let manifest: RunManifest | null = null;
  try {
    manifest = await store.read<RunManifest>(runId, "manifest.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pendingCheckpointIds: string[] = [];
  for (const checkpointId of manifest?.checkpoints ?? []) {
    try {
      const checkpoint = await store.read<CheckpointRecord>(runId, `checkpoints/${checkpointId}.json`);
      if (checkpoint.status === "pending") pendingCheckpointIds.push(checkpointId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const reviewContents = await readOptional(resolve(changeRoot, "review.md"));
  const review = reviewContents
    ? parseReviewArtifact(reviewContents, resolve(changeRoot, "review.md"))
    : null;

  const verificationContents = await readOptional(resolve(changeRoot, "verification.md"));
  const verification = verificationContents
    ? parseVerificationArtifact(verificationContents, resolve(changeRoot, "verification.md"))
    : null;

  const capturedAt = now();
  return createChangeSnapshot({
    capturedAt,
    openSpec: {
      observedAt: capturedAt,
      changeName: options.changeName,
      planningComplete,
      tasks,
      artifactDigest,
    },
    repository: {
      observedAt: capturedAt,
      repositoryId: identity.id,
      commonDirectory: identity.commonDirectory,
      worktree: identity.root,
      head: head.commit,
      indexDigest: computeIndexDigest(statusEntries),
      diffDigest: computeDiffDigest(diffText),
      sourceDigest: computeSourceDigest(head.commit, diffText),
    },
    runtime: manifest ? { observedAt: capturedAt, manifest } : null,
    review: review ? { observedAt: capturedAt, artifact: review } : null,
    validation: verification
      ? {
          observedAt: capturedAt,
          result: verification.result,
          artifactDigest: verification.artifactDigest,
          sourceDigest: verification.sourceDigest,
        }
      : null,
    pendingCheckpointIds,
  });
}

export async function loadProductionChangeUsage(
  options: ProductionRuntimeOptions & { changeName: string },
): Promise<ChangeUsageSummary | null> {
  const cwd = options.cwd ?? process.cwd();
  const store = createChangeUsageStore(cwd);
  return loadChangeUsageSummary(store, options.changeName);
}

/** Persists usage/cost telemetry for real agent invocations, tying them to the change being worked on. */
export async function recordChangeAgentRuns(
  options: ProductionRuntimeOptions & {
    changeName: string;
    phase: UsagePhase;
    runs: readonly Pick<AgentRun, "role" | "model" | "tokensIn" | "tokensOut" | "costUsd" | "ms">[];
  },
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const store = createChangeUsageStore(cwd);
  const runId = changeRunId(options.changeName);
  const records = options.runs.map((run) => usageFromLegacyRun(runId, options.phase, run));
  await recordChangeUsage(store, options.changeName, records);
}

export async function touchActiveChange(options: ProductionRuntimeOptions & { changeName: string }): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const store = createChangeUsageStore(cwd);
  await setActiveChange(store, options.changeName, options.now);
}
