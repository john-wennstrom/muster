import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadModelStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
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
import { renderChangeStatus, type ChangeCommandDependencies } from "./change-command.ts";
import {
  createCommandRunContext,
  createCommandRunId,
  renderCommandOutcome,
  resolveProductionChange,
  validateChangeSlug,
  type CommandOutcome,
  type ResolvedChange,
  type ResolveProductionChangeOptions,
} from "./command-runtime.ts";
import { resolveProductionModelStack, runProductionPlanning } from "./planning-runtime.ts";
import { runProductionReview } from "./review-runtime.ts";
import { runProductionImplementation } from "./implementation-runtime.ts";
import { runProductionFinish, runProductionVerification } from "./verification-runtime.ts";
import type { AgentRunObserver } from "./agent-progress.ts";

// Last-resort fallback only — used when no --fh-config/--architect is configured and no
// MUSTER_EXPLORE_MODEL override is set. Mirrors fusion-harness's own DEFAULT_ARCHITECT.
const DEFAULT_EXPLORE_MODEL = "anthropic/claude-fable-5";
// A single read-only exploration turn is interactive, not a long build — cap well
// under the legacy 8h child-timeout floor.
const EXPLORE_CHILD_TIMEOUT_MS = 30 * 60 * 1000;

/** Same `--flag value` / `--flag=value` reading fusion-harness.ts uses before pi resolves registered flags. */
function rawCliFlag(name: string, argv: readonly string[]): string {
  const long = `--${name}`;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === long) return argv[index + 1]?.trim() ?? "";
    if (argv[index]!.startsWith(`${long}=`)) return argv[index]!.slice(long.length + 1).trim();
  }
  return "";
}

/**
 * Resolve the explore agent's model with the same precedence fusion-harness uses for its
 * own architect role, so /change explore automatically follows whatever the user already
 * configured and authenticated for /refine, /implement, etc.:
 * `MUSTER_EXPLORE_MODEL` env override > --fh-config YAML's architect slot > --architect
 * legacy flag > a hardcoded default (only reached when nothing else is configured).
 */
export function resolveExploreModel(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  const override = env.MUSTER_EXPLORE_MODEL?.trim();
  if (override) return override;
  const configPath = rawCliFlag("fh-config", argv);
  if (configPath) {
    try {
      return loadModelStack(configPath).architect.model;
    } catch {
      // fall through — an invalid/missing --fh-config here is not explore's job to report
    }
  }
  const architectFlag = rawCliFlag("architect", argv);
  if (architectFlag) return architectFlag;
  return DEFAULT_EXPLORE_MODEL;
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
  signal?: AbortSignal;
  argv?: readonly string[];
  onAgentStart?: AgentRunObserver;
  runners?: {
    explore?(options: {
      cwd: string;
      prompt: string;
      signal?: AbortSignal;
    }): Promise<CommandOutcome>;
    planning?: typeof runProductionPlanning;
    review?: typeof runProductionReview;
    implementation?: typeof runProductionImplementation;
    verification?: typeof runProductionVerification;
    finish?: typeof runProductionFinish;
  };
  ports?: {
    resolveChange?(options: ResolveProductionChangeOptions): Promise<ResolvedChange>;
    loadSnapshot?(options: ProductionRuntimeOptions & { changeName: string }): Promise<ChangeSnapshot | null>;
    loadUsage?(options: ProductionRuntimeOptions & { changeName: string }): Promise<ChangeUsageSummary | null>;
    activateChange?(options: ProductionRuntimeOptions & { changeName: string }): Promise<void>;
  };
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

export function createProductionExploreDependencies(
  cwd: string,
  signal?: AbortSignal,
  options: {
    argv?: readonly string[];
    onAgentStart?: AgentRunObserver;
    runChild?: typeof runLegacyReadOnlyChild;
  } = {},
): ExploreDependencies {
  return {
    async runAgent(request) {
      const slot = resolveProductionModelStack(options.argv).architect;
      const model = resolveExploreModel(process.env, options.argv);
      const run = newRun("ARCHITECT", model, { ...slot, model });
      const runId = `explore-${randomUUID()}`;
      await (options.runChild ?? runLegacyReadOnlyChild)({
        run,
        onAgentStart: options.onAgentStart,
        prompt: renderExplorePrompt(request),
        systemPrompt: slot.systemPrompt,
        appendSystemPrompts: slot.appendSystemPrompts,
        role: "architect",
        runId,
        childId: "explore",
        taskId: "change.explore",
        description: "Read-only exploration for /change explore",
        assignee: slot.id,
        thinking: slot.thinking,
        sessionDir: resolve(cwd, ".fusion", "runs", runId, "sessions", "explore"),
        cwd,
        timeoutMs: EXPLORE_CHILD_TIMEOUT_MS,
        signal,
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
  const resolvedChanges = new Map<string, ResolvedChange>();
  const resolveChange = async (candidate: string, allowMissing: boolean): Promise<ResolvedChange> => {
    const name = validateChangeSlug(candidate);
    if (options.ports?.resolveChange) {
      return options.ports.resolveChange({ planningHome: cwd, changeName: name, allowMissing });
    }
    const adapter = new OpenSpecAdapter({ cwd, signal: options.signal });
    try {
      const status = await adapter.status(name);
      if (status.changeName !== name) {
        throw new HarnessError(
          "CHANGE_SLUG_COLLISION",
          `OpenSpec resolved ${name} as a different change identity`,
          { requested: name, resolved: status.changeName },
        );
      }
      return resolveProductionChange({
        planningHome: status.planningHome.root,
        changesDirectory: status.planningHome.changesDir,
        changeRoot: status.changeRoot,
        changeName: name,
      });
      if (run.status === "aborted") {
        throw new HarnessError("PROCESS_CANCELLED", "Exploration cancelled", { runId });
      }
    } catch (error) {
      if (!allowMissing || !(error instanceof HarnessError) || error.code !== "OPENSPEC_COMMAND_FAILED") throw error;
      return resolveProductionChange({ planningHome: cwd, changeName: name, allowMissing: true });
    }
  };
  return {
    forInvocation(context) {
      return createProductionChangeCommandDependencies({
        ...options,
        cwd: context.cwd ?? cwd,
        signal: context.signal ?? options.signal,
        onAgentStart: context.onAgentStart ?? options.onAgentStart,
      });
    },
    async resolveChangeName(explicit, action) {
      const store = createChangeUsageStore(cwd);
      if (explicit) {
        const change = await resolveChange(explicit, action === "propose");
        resolvedChanges.set(change.name, change);
        return change.name;
      }
      const remembered = await getActiveChange(store);
      if (!remembered) return null;
      const change = await resolveChange(remembered, false);
      resolvedChanges.set(change.name, change);
      return change.name;
    },
    activateChange: (changeName) => (options.ports?.activateChange ?? touchActiveChange)({ ...options, cwd, changeName }),
    async createRunContext(command, context) {
      const change = command.changeName
        ? resolvedChanges.get(command.changeName) ?? await resolveProductionChange({
          planningHome: cwd,
          changeName: command.changeName,
          allowMissing: command.action === "propose",
        })
        : undefined;
      const stack = command.action === "status" ? undefined : resolveProductionModelStack(options.argv);
      const stateful = ["implement", "resume", "verify", "finish"].includes(command.action);
      return createCommandRunContext({
        action: command.action,
        repositoryCwd: cwd,
        planningHome: change?.planningHome ?? cwd,
        change,
        runId: command.action === "status" || command.action === "explore"
          ? undefined
          : stateful && command.changeName
            ? changeRunId(command.changeName)
            : createCommandRunId(command.action, command.changeName),
        models: {
          architect: stack?.architect.model,
          builder: stack?.primaryBuilder.model,
          reviewer: stack?.builders.find((slot) => slot.model !== stack.architect.model)?.model ?? stack?.primaryBuilder.model,
          validator: stack?.architect.model,
        },
        signal: options.signal ?? context.signal,
        output: {
          write(outcome) {
            const rendered = renderCommandOutcome(outcome);
            if (context.sendMessage) context.sendMessage(rendered);
            else context.ui.notify(rendered, outcome.status === "failure" ? "error" : outcome.status === "success" ? "info" : "warning");
          },
        },
      });
    },
    loadSnapshot: (changeName) => (options.ports?.loadSnapshot ?? loadProductionChangeSnapshot)({ ...options, cwd, changeName }),
    loadChangeUsage: (changeName) => (options.ports?.loadUsage ?? loadProductionChangeUsage)({ ...options, cwd, changeName }),
    handlers: {
      async explore(command, context) {
        const prompt = command.arguments.join(" ").trim();
        if (!prompt) {
          return {
            status: "blocked" as const,
            action: "explore" as const,
            summary: "Usage: /change explore <prompt>",
          };
        }
        if (options.runners?.explore) {
          return options.runners.explore({ cwd, prompt, signal: options.signal ?? context.signal });
        }
        const authoritativeContext = command.changeName ? { changeName: command.changeName } : undefined;
        const exploration = await explore(
          { prompt, authoritativeContext },
          createProductionExploreDependencies(cwd, options.signal ?? context.signal, {
            argv: options.argv,
            onAgentStart: context.onAgentStart ?? options.onAgentStart,
          }),
        );
        return {
          status: "success" as const,
          action: "explore" as const,
          summary: exploration.analysis.content,
        };
      },
      async propose(command, context) {
        if (!command.changeName) {
          return {
            status: "blocked" as const,
            action: "propose" as const,
            summary: "Usage: /change propose <change> <goal>",
            next: "/change propose <change> <goal>",
          };
        }
        return (options.runners?.planning ?? runProductionPlanning)({
          cwd,
          changeName: command.changeName,
          phase: "propose",
          onAgentStart: context.onAgentStart ?? options.onAgentStart,
          runId: context.run?.runId,
          prompt: command.arguments.join(" ").trim(),
          signal: options.signal,
          argv: options.argv,
        });
      },
      async refine(command, context) {
        return (options.runners?.planning ?? runProductionPlanning)({
          cwd,
          changeName: command.changeName!,
          phase: "refine",
          onAgentStart: context.onAgentStart ?? options.onAgentStart,
          runId: context.run?.runId,
          prompt: command.arguments.join(" ").trim(),
          signal: options.signal,
          argv: options.argv,
        });
      },
      async review(command, context) {
        return (options.runners?.review ?? runProductionReview)({
          onAgentStart: context.onAgentStart ?? options.onAgentStart,
          cwd,
          changeName: command.changeName!,
          prompt: command.arguments.join(" ").trim() || undefined,
          signal: options.signal,
          argv: options.argv,
          runId: context.run?.runId,
        });
      },
      async implement(command, context) {
        const snapshot = await (options.ports?.loadSnapshot ?? loadProductionChangeSnapshot)({
          ...options,
          cwd,
          changeName: command.changeName!,
        });
        return (options.runners?.implementation ?? runProductionImplementation)({
          onAgentStart: context.onAgentStart ?? options.onAgentStart,
          cwd,
          changeName: command.changeName!,
          reviewFreshness: snapshot?.freshness.review ?? "missing",
          signal: options.signal,
          argv: options.argv,
        });
      },
      async resume(command, context) {
        const snapshot = await (options.ports?.loadSnapshot ?? loadProductionChangeSnapshot)({
          ...options,
          cwd,
          changeName: command.changeName!,
        });
        return (options.runners?.implementation ?? runProductionImplementation)({
          cwd,
          changeName: command.changeName!,
          reviewFreshness: snapshot?.freshness.review ?? "missing",
          checkpointId: command.arguments[0]!,
          onAgentStart: context.onAgentStart ?? options.onAgentStart,
          confirmedBy: context.actor ?? "local-user",
          signal: options.signal,
          argv: options.argv,
        });
      },
      async verify(command) {
        return (options.runners?.verification ?? runProductionVerification)({
          cwd,
          changeName: command.changeName!,
          signal: options.signal,
          argv: options.argv,
        });
      },
      async finish(command) {
        return (options.runners?.finish ?? runProductionFinish)({
          cwd,
          changeName: command.changeName!,
          signal: options.signal,
          argv: options.argv,
        });
      },
      async status(command) {
        const snapshot = await (options.ports?.loadSnapshot ?? loadProductionChangeSnapshot)({
          ...options,
          cwd,
          changeName: command.changeName!,
        });
        if (!snapshot) {
          return {
            status: "blocked" as const,
            action: "status" as const,
            changeName: command.changeName,
            summary: `Change ${command.changeName} does not have a readable production snapshot.`,
          };
        }
        const usage = await (options.ports?.loadUsage ?? loadProductionChangeUsage)({
          ...options,
          cwd,
          changeName: command.changeName!,
        });
        return {
          status: "success" as const,
          action: "status" as const,
          changeName: command.changeName,
          summary: renderChangeStatus(snapshot, usage),
        };
      },
    },
  };
}
