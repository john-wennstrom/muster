import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { newRun, runOk, runError, type AgentRun } from "../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyReadOnlyChild } from "../agents/legacy-adapter.ts";
import { createChangeSnapshot, type ChangeSnapshot } from "../controller/change-snapshot.ts";
import { explore, type ExploreAgentRequest, type ExploreDependencies } from "../controller/explore.ts";
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
  getActiveChange,
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
import type { ChangeCommandDependencies } from "./change-command.ts";

// Shipped default for the read-only explore agent when no override is configured;
// mirrors fusion-harness's own DEFAULT_ARCHITECT so behavior stays consistent.
const DEFAULT_EXPLORE_MODEL = "anthropic/claude-fable-5";
// A single read-only exploration turn is interactive, not a long build — cap well
// under the legacy 8h child-timeout floor.
const EXPLORE_CHILD_TIMEOUT_MS = 30 * 60 * 1000;

/** `MUSTER_EXPLORE_MODEL` lets operators override the model without touching code. */
export function resolveExploreModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSTER_EXPLORE_MODEL?.trim() || DEFAULT_EXPLORE_MODEL;
}

export function renderExplorePrompt(request: ExploreAgentRequest): string {
  const sections = [request.prompt];
  if (Object.keys(request.authoritativeContext).length > 0) {
    sections.push(`AUTHORITATIVE CONTEXT\n${JSON.stringify(request.authoritativeContext, null, 2)}`);
  }
  if (request.supplementalFacts.length > 0) {
    sections.push(`SUPPLEMENTAL FACTS\n${JSON.stringify(request.supplementalFacts, null, 2)}`);
  }
  return sections.join("\n\n");
}

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

export interface ProductionRuntimeOptions {
  cwd?: string;
  now?: () => string;
}

export async function loadProductionChangeSnapshot(
  options: ProductionRuntimeOptions & { changeName: string },
): Promise<ChangeSnapshot | null> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date().toISOString());
  const changeRoot = resolve(cwd, "openspec", "changes", options.changeName);
  const tasksPath = resolve(changeRoot, "tasks.md");
  if (!(await pathExists(tasksPath))) return null;

  const git = new GitAdapter(cwd);
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
    const status = await new OpenSpecAdapter({ cwd }).status(options.changeName);
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

export function createProductionExploreDependencies(cwd: string): ExploreDependencies {
  return {
    async runAgent(request) {
      const model = resolveExploreModel();
      const run = newRun("ARCHITECT", model);
      const runId = `explore-${randomUUID()}`;
      await runLegacyReadOnlyChild({
        run,
        prompt: renderExplorePrompt(request),
        role: "architect",
        runId,
        childId: "explore",
        taskId: "change.explore",
        description: "Read-only exploration for /change explore",
        assignee: "explore",
        thinking: "medium",
        sessionDir: resolve(cwd, ".fusion", "runs", runId, "sessions", "explore"),
        cwd,
        timeoutMs: EXPLORE_CHILD_TIMEOUT_MS,
      });
      if (!runOk(run)) {
        throw new HarnessError(
          "EXPLORE_AGENT_FAILED",
          `Explore agent failed: ${runError(run)}`,
          { runId, exitCode: run.exitCode },
        );
      }
      return { model: run.model, content: run.text };
    },
  };
}

export function createProductionChangeCommandDependencies(
  options: ProductionRuntimeOptions = {},
): ChangeCommandDependencies {
  const cwd = options.cwd ?? process.cwd();
  return {
    async resolveChangeName(explicit) {
      const store = createChangeUsageStore(cwd);
      if (explicit) {
        await setActiveChange(store, explicit, options.now);
        return explicit;
      }
      return getActiveChange(store);
    },
    loadSnapshot: (changeName) => loadProductionChangeSnapshot({ ...options, cwd, changeName }),
    loadChangeUsage: (changeName) => loadProductionChangeUsage({ ...options, cwd, changeName }),
    handlers: {
      async explore(command, context) {
        const prompt = command.arguments.join(" ").trim();
        if (!prompt) {
          context.ui.notify("Usage: /change explore <prompt>", "warning");
          return;
        }
        const authoritativeContext = command.changeName ? { changeName: command.changeName } : undefined;
        const exploration = await explore(
          { prompt, authoritativeContext },
          createProductionExploreDependencies(cwd),
        );
        context.ui.notify(exploration.analysis.content, "info");
      },
    },
  };
}
