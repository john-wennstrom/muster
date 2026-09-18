import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dependencyReportSchema } from "../agents/reports.ts";
import { verifyChange } from "../controller/verify.ts";
import { computeSourceDigest } from "../execution/change-digests.ts";
import { GitAdapter } from "../execution/git.ts";
import { parseTaskDocument } from "../execution/task-parser.ts";
import { validateTaskDocument } from "../execution/task-schema.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createChangeUsageStore, changeRunId } from "../persistence/change-usage-store.ts";
import {
  checkpointRecordSchema,
  reviewRecordSchema,
  runManifestSchema,
  taskResultSchema,
  validationRecordSchema,
} from "../persistence/records.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../review/artifact-digest.ts";
import { parseReviewArtifact } from "../review/review-artifact.ts";
import type { CommandEvidence, FinalValidatorDependencies } from "../review/validator.ts";
import { runHostCommand } from "../tools/host-runner.ts";
import type { ParsedChangeCommand, ChangeCommandContext } from "../runtime/change-command.ts";
import type { CommandOutcome, ProductionRuntimeOptions } from "../runtime/command.ts";
import { parseVerificationCommand } from "../runtime/implementation.ts";
import { resolveProductionModelStack } from "../runtime/planning.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readDirectoryRecords<T>(
  store: ReturnType<typeof createChangeUsageStore>,
  runId: string,
  directory: string,
  schema: { parse(value: unknown): T },
): Promise<T[]> {
  return Promise.all((await store.list(runId, directory)).map(async (path) => schema.parse(await store.read(runId, path))));
}

export interface ProductionVerificationPorts {
  runCommand?(command: string, worktree: string, signal?: AbortSignal): Promise<CommandEvidence>;
}

export interface ProductionVerificationOptions {
  cwd: string;
  changeName: string;
  signal?: AbortSignal;
  argv?: readonly string[];
  openSpec?: OpenSpecAdapter;
  ports?: ProductionVerificationPorts;
  now?: () => Date;
}

async function verificationState(options: ProductionVerificationOptions) {
  const adapter = options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal });
  const [status, apply, validation] = await Promise.all([
    adapter.status(options.changeName),
    adapter.applyInstructions(options.changeName),
    adapter.validate(options.changeName),
  ]);
  const changeRoot = resolve(status.changeRoot);
  const artifacts = await discoverReviewedArtifacts(options.cwd, changeRoot);
  const artifactDigest = await hashReviewedArtifacts(artifacts);
  const tasksPath = status.artifactPaths.tasks?.existingOutputPaths[0] ?? resolve(changeRoot, "tasks.md");
  const tasksContents = await readFile(tasksPath, "utf8");
  const parsed = parseTaskDocument(tasksContents, tasksPath);
  const requirements = new Set<string>();
  const scenarios = new Set<string>();
  for (const task of parsed.tasks) {
    const metadata = task.metadata as { requirements?: unknown; scenarios?: unknown };
    if (Array.isArray(metadata.requirements)) for (const value of metadata.requirements) if (typeof value === "string") requirements.add(value);
    if (Array.isArray(metadata.scenarios)) for (const value of metadata.scenarios) if (typeof value === "string") scenarios.add(value);
  }
  const tasks = validateTaskDocument(parsed, { requirements, scenarios }).tasks;
  const runId = changeRunId(options.changeName);
  const store = createChangeUsageStore(options.cwd);
  const manifest = runManifestSchema.parse(await store.read(runId, "manifest.json"));
  const [taskResults, reviews, reports, checkpoints] = await Promise.all([
    readDirectoryRecords(store, runId, "task-results", taskResultSchema),
    readDirectoryRecords(store, runId, "reviews", reviewRecordSchema),
    readDirectoryRecords(store, runId, "reports", dependencyReportSchema),
    readDirectoryRecords(store, runId, "checkpoints", checkpointRecordSchema),
  ]);
  const git = new GitAdapter(manifest.worktree.path, undefined, undefined, options.signal);
  const [identity, head, gitStatus, diff, worktrees] = await Promise.all([
    git.identity(),
    git.head(),
    git.status(),
    git.diff(),
    git.worktrees(),
  ]);
  const sourceDigest = computeSourceDigest(head.commit, diff);
  const reviewPath = resolve(changeRoot, "review.md");
  const planningReview = await exists(reviewPath)
    ? parseReviewArtifact(await readFile(reviewPath, "utf8"), reviewPath)
    : null;
  const runCommand = options.ports?.runCommand ?? (async (command: string, worktree: string, signal?: AbortSignal) => {
    const parsedCommand = parseVerificationCommand(command);
    const result = await runHostCommand({
      worktreePath: worktree,
      request: {
        profile: "verification",
        executable: parsedCommand.executable,
        args: parsedCommand.args,
        cwd: worktree,
      },
      signal,
    });
    return { command, exitCode: result.exitCode ?? -1 };
  });
  let commandEvidence: CommandEvidence[] | null = null;
  const collectCommands = async (): Promise<CommandEvidence[]> => {
    if (commandEvidence) return commandEvidence;
    const commands = [...new Set(tasks.flatMap((task) => task.verify))];
    commandEvidence = [];
    for (const command of commands) commandEvidence.push(await runCommand(command, manifest.worktree.path, options.signal));
    commandEvidence.push(await runCommand("bun test", manifest.worktree.path, options.signal));
    return commandEvidence;
  };

  const dependencies: FinalValidatorDependencies = {
    readOpenSpec: async () => ({ status, apply, validation, artifactDigest }),
    readTasks: async () => tasks.map((task) => ({
      id: task.id,
      done: task.checked,
      requirements: task.requirements,
      scenarios: task.scenarios,
      verify: task.verify,
    })),
    readEvidence: async () => ({ manifest, taskResults, reviews }),
    runTests: async () => {
      const evidence = await collectCommands();
      return { focused: evidence.slice(0, -1), fullSuite: evidence.at(-1) ?? null };
    },
    readFindings: async () => ({
      unresolved: reviews
        .filter((review) => review.verdict === "REVISE")
        .flatMap((review) => review.findings.map((message) => ({ severity: "blocking" as const, source: review.kind, message }))),
    }),
    checkDesign: async () => {
      const designPath = resolve(changeRoot, "design.md");
      const available = await exists(designPath);
      return {
        available,
        aligned: available && reviews.every((review) => review.verdict === "APPROVE"),
        evidence: available ? [designPath, ...reviews.map((review) => `${review.kind}:${review.verdict}`)] : [],
      };
    },
    readFreshness: async () => ({
      artifactDigest,
      sourceDigest,
      planningReviewDigest: planningReview?.artifactDigest ?? null,
      staleInputs: planningReview?.artifactDigest === artifactDigest ? [] : ["Planning review digest is missing or stale"],
    }),
    readReports: async () => ({ reports }),
    readRepository: async () => ({
      repositoryId: identity.id,
      commonDirectory: identity.commonDirectory,
      worktreePath: identity.root,
      head: head.commit,
      status: gitStatus,
      worktrees,
      sourceDigest,
      writerActive: manifest.writer !== null,
      pendingCheckpointIds: checkpoints.filter((checkpoint) => checkpoint.status === "pending").map((checkpoint) => checkpoint.id),
      discrepancies: [],
    }),
    now: () => (options.now ?? (() => new Date()))().toISOString(),
  };
  return {
    adapter,
    status,
    changeRoot,
    artifactDigest,
    sourceDigest,
    head,
    diff,
    tasks,
    runId,
    store,
    manifest,
    dependencies,
    collectCommands,
  };
}

function createHashDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function runProductionVerification(options: ProductionVerificationOptions): Promise<CommandOutcome> {
  const state = await verificationState(options);
  const stack = resolveProductionModelStack(options.argv);
  const commandEvidence = await state.collectCommands();
  const result = await verifyChange({
    changeName: options.changeName,
    changeRoot: state.changeRoot,
    validation: {
      runId: state.runId,
      changeName: options.changeName,
      sessionsRoot: resolve(options.cwd, ".fusion", "runs", state.runId, "sessions"),
      dependencies: state.dependencies,
    },
    summary: {
      model: stack.architect.model,
      artifactDigest: state.artifactDigest,
      sourceDigest: state.sourceDigest,
      repositoryState: { kind: state.diff ? "diff" : "commit", identity: state.diff ? createHashDigest(state.diff) : state.head.commit },
      commands: commandEvidence.map((command) => ({ ...command, evidenceLinks: [] })),
      requirementEvidence: state.tasks.flatMap((task) => task.requirements.slice(0, 1).flatMap((requirement) =>
        task.scenarios.slice(0, 1).map((scenario) => ({
          requirement,
          scenario,
          evidenceLinks: [{ label: `Task ${task.id} verification`, href: task.verify[0] ?? "tasks.md" }],
        }))
      )),
      findings: [],
      deviations: [],
      warnings: [],
    },
  });
  await state.store.write(state.runId, "validation.json", validationRecordSchema.parse({
    schemaVersion: 1,
    runId: state.runId,
    result: result.validation.result,
    sourceDigest: state.sourceDigest,
    artifactDigest: state.artifactDigest,
    commands: commandEvidence,
    createdAt: result.validation.validatedAt,
  }));
  return {
    status: result.validation.result === "PASS" ? "success" : "blocked",
    action: "verify",
    changeName: options.changeName,
    runId: state.runId,
    summary: `Final verification ${result.validation.result}: ${result.validation.blockingReasons.join("; ") || "all gates passed"}.`,
    next: `/change ${result.nextAction} ${options.changeName}`,
    blocker: result.validation.result === "FAIL" ? { kind: "invalid_evidence", message: result.validation.blockingReasons.join("; ") } : undefined,
  };
}

/** Builds the `/change verify` handler bound to the given cwd/options closure. */
export function createVerifyHandler(cwd: string, options: ProductionRuntimeOptions) {
  return async function verifyHandler(
    command: ParsedChangeCommand & { changeName?: string },
    _context: ChangeCommandContext,
  ): Promise<CommandOutcome | void> {
    return (options.runners?.verification ?? runProductionVerification)({
      cwd,
      changeName: command.changeName!,
      signal: options.signal,
      argv: options.argv,
    });
  };
}
