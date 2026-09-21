import { randomUUID } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AgentRun } from "../agents/run-record.ts";
import type { ChangeAction } from "../controller/action-resolver.ts";
import type { ChangeSnapshot } from "../controller/change-snapshot.ts";
import type { ChangeUsageSummary } from "../persistence/change-usage-store.ts";
import type { ProductionPlanningOptions } from "./phases/planning.ts";
import type { ProductionImplementationOptions } from "./phases/implementation.ts";
import type { ProductionReviewOptions } from "./phases/review.ts";
import type { ProductionVerificationOptions } from "./phases/verification.ts";
import type { ProductionFinishOptions } from "./phases/finish.ts";
import type { ProductionExplorationOptions } from "./phases/exploration.ts";
import { pathExists } from "../shared/fs.ts";
import { isWithin } from "../shared/paths.ts";
import { HarnessError } from "../shared/errors.ts";

export type CommandOutcomeStatus = "success" | "blocked" | "cancelled" | "failure";

export interface CommandBlocker {
  kind:
    | "missing_artifact"
    | "stale_digest"
    | "model_unavailable"
    | "pending_checkpoint"
    | "invalid_change"
    | "lifecycle"
    | "external_capability"
    | "invalid_evidence";
  message: string;
  artifact?: string;
  checkpointIds?: readonly string[];
}

export interface CommandOutcome {
  status: CommandOutcomeStatus;
  action: ChangeAction;
  changeName?: string;
  runId?: string;
  summary: string;
  next?: string;
  code?: string;
  blocker?: CommandBlocker;
}

export interface CommandOutputSink {
  write(outcome: CommandOutcome): void | Promise<void>;
}

export interface ResolvedRoleModels {
  architect?: string;
  builder?: string;
  reviewer?: string;
  validator?: string;
}

export interface ResolvedChange {
  name: string;
  planningHome: string;
  changesDirectory: string;
  changeRoot: string;
  exists: boolean;
}

export interface ResolvedWorktree {
  path: string;
  repositoryId?: string;
}

export interface CommandRunContext {
  action: ChangeAction;
  repositoryCwd: string;
  planningHome: string;
  change?: ResolvedChange;
  worktree?: ResolvedWorktree;
  runId?: string;
  models: Readonly<ResolvedRoleModels>;
  signal: AbortSignal;
  output: CommandOutputSink;
}

export interface CreateCommandRunContextOptions {
  action: ChangeAction;
  repositoryCwd: string;
  planningHome?: string;
  change?: ResolvedChange;
  worktree?: ResolvedWorktree;
  runId?: string;
  /** A thunk defers model resolution until a consumer actually reads `models`. */
  models?: ResolvedRoleModels | (() => ResolvedRoleModels);
  signal?: AbortSignal;
  output: CommandOutputSink;
}

export function createCommandRunContext(options: CreateCommandRunContextOptions): CommandRunContext {
  const planningHome = resolve(options.planningHome ?? options.repositoryCwd);
  const resolveModels = typeof options.models === "function"
    ? options.models
    : () => ({ ...options.models });
  let models: Readonly<ResolvedRoleModels> | undefined;
  return Object.freeze({
    action: options.action,
    repositoryCwd: resolve(options.repositoryCwd),
    planningHome,
    change: options.change ? Object.freeze({ ...options.change }) : undefined,
    worktree: options.worktree ? Object.freeze({ ...options.worktree }) : undefined,
    runId: options.runId,
    get models(): Readonly<ResolvedRoleModels> {
      models ??= Object.freeze(resolveModels());
      return models;
    },
    signal: options.signal ?? new AbortController().signal,
    output: options.output,
  });
}

export function createCommandRunId(action: ChangeAction, changeName?: string): string {
  return `${action}-${changeName ?? "standalone"}-${randomUUID()}`;
}

const canonicalSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateChangeSlug(value: string): string {
  const slug = value.trim();
  if (
    !slug ||
    isAbsolute(slug) ||
    slug.includes("/") ||
    slug.includes("\\") ||
    slug === "." ||
    slug === ".." ||
    !canonicalSlug.test(slug)
  ) {
    throw new HarnessError(
      "CHANGE_IDENTIFIER_INVALID",
      `Invalid change identifier ${JSON.stringify(value)}; expected a lowercase kebab-case slug`,
      { value, grammar: canonicalSlug.source },
    );
  }
  return slug;
}

function normalizedDirectoryKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export interface ResolveProductionChangeOptions {
  planningHome: string;
  changeName: string;
  allowMissing?: boolean;
  changesDirectory?: string;
  changeRoot?: string;
}

export async function resolveProductionChange(
  options: ResolveProductionChangeOptions,
): Promise<ResolvedChange> {
  const name = validateChangeSlug(options.changeName);
  const planningHome = await realpath(resolve(options.planningHome));
  const changesDirectoryCandidate = resolve(options.changesDirectory ?? resolve(planningHome, "openspec", "changes"));
  const changesDirectory = await realpath(changesDirectoryCandidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && options.allowMissing) return changesDirectoryCandidate;
    if (error.code === "ENOENT") {
      throw new HarnessError(
        "CHANGE_NOT_FOUND",
        `Change ${name} does not exist under ${changesDirectoryCandidate}`,
        { name, planningHome, changesDirectory: changesDirectoryCandidate },
        { cause: error },
      );
    }
    throw error;
  });
  if (!isWithin(planningHome, changesDirectory)) {
    throw new HarnessError(
      "CHANGE_PATH_UNSAFE",
      "The resolved OpenSpec changes directory escapes the planning home",
      { planningHome, changesDirectory },
    );
  }

  const entries = await readdir(changesDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && options.allowMissing) return [];
    throw error;
  });
  const key = normalizedDirectoryKey(name);
  const matches = entries.filter((entry) => entry.isDirectory() && normalizedDirectoryKey(entry.name) === key);
  if (matches.length > 1 || (matches.length === 1 && matches[0]!.name !== name)) {
    throw new HarnessError(
      "CHANGE_SLUG_COLLISION",
      `Change identifier ${name} collides with non-canonical directory names`,
      { name, matches: matches.map((entry) => entry.name).sort() },
    );
  }

  const changeRootCandidate = resolve(options.changeRoot ?? resolve(changesDirectory, name));
  if (!isWithin(changesDirectory, changeRootCandidate)) {
    throw new HarnessError(
      "CHANGE_PATH_UNSAFE",
      `Resolved change path for ${name} escapes the OpenSpec changes directory`,
      { name, changesDirectory, changeRoot: changeRootCandidate },
    );
  }
  const changeExists = await pathExists(changeRootCandidate);
  if (!changeExists && !options.allowMissing) {
    throw new HarnessError(
      "CHANGE_NOT_FOUND",
      `Change ${name} does not exist under ${changesDirectory}`,
      { name, planningHome, changesDirectory },
    );
  }
  const changeRoot = changeExists ? await realpath(changeRootCandidate) : changeRootCandidate;
  if (!isWithin(changesDirectory, changeRoot)) {
    throw new HarnessError(
      "CHANGE_PATH_UNSAFE",
      `Resolved change path for ${name} escapes the OpenSpec changes directory`,
      { name, changesDirectory, changeRoot },
    );
  }
  return Object.freeze({ name, planningHome, changesDirectory, changeRoot, exists: changeExists });
}

export function renderCommandOutcome(outcome: CommandOutcome): string {
  const heading = `## /change ${outcome.action}${outcome.changeName ? ` ${outcome.changeName}` : ""}`;
  const fields = [
    heading,
    "",
    `Status: ${outcome.status}`,
    outcome.runId ? `Run: ${outcome.runId}` : undefined,
    outcome.code ? `Code: ${outcome.code}` : undefined,
    "",
    outcome.summary,
    outcome.next ? `Next: ${outcome.next}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return fields.join("\n");
}

/** Invocation configuration: everything the runtime needs to do real work. */
export interface RuntimeConfig {
  cwd?: string;
  now?: () => string;
  signal?: AbortSignal;
  argv?: readonly string[];
  onAgentStart?(run: AgentRun): void;
}

/** The narrow input every change-state port accepts, instead of the whole options bag. */
export interface ChangeStateQuery {
  cwd: string;
  changeName: string;
  signal?: AbortSignal;
  now?: () => string;
}

/** Test-only substitution points, kept separate from configuration. */
export interface RuntimeOverrides {
  runners?: {
    explore?(options: ProductionExplorationOptions): Promise<CommandOutcome>;
    planning?(options: ProductionPlanningOptions): Promise<CommandOutcome>;
    review?(options: ProductionReviewOptions): Promise<CommandOutcome>;
    implementation?(options: ProductionImplementationOptions): Promise<CommandOutcome>;
    verification?(options: ProductionVerificationOptions): Promise<CommandOutcome>;
    finish?(options: ProductionFinishOptions): Promise<CommandOutcome>;
  };
  ports?: {
    resolveChange?(options: ResolveProductionChangeOptions): Promise<ResolvedChange>;
    loadSnapshot?(query: ChangeStateQuery): Promise<ChangeSnapshot | null>;
    loadUsage?(query: ChangeStateQuery): Promise<ChangeUsageSummary | null>;
    activateChange?(query: ChangeStateQuery): Promise<void>;
  };
}

export interface ProductionRuntimeOptions extends RuntimeConfig, RuntimeOverrides {}

/** Narrows the invocation options to the inputs a change-state port accepts. */
export function changeStateQuery(
  options: RuntimeConfig,
  cwd: string,
  changeName: string,
): ChangeStateQuery {
  return { cwd, changeName, signal: options.signal, now: options.now };
}
