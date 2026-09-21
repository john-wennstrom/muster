import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dependencyReportSchema } from "../../agents/reports.ts";
import { verifyChange } from "../../controller/verify.ts";
import { computeSourceDigest, readSourceDigest } from "../../execution/change-digests.ts";
import { GitAdapter } from "../../execution/git.ts";
import { loadValidatedTaskDocument } from "../../execution/load-tasks.ts";
import { reusableCommands } from "../../execution/verification-reuse.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import { openChangeRun } from "../../persistence/run-store.ts";
import {
  checkpointRecordSchema,
  reviewRecordSchema,
  taskResultSchema,
  validationRecordSchema,
} from "../../persistence/records.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../../review/artifact-digest.ts";
import { parseReviewArtifact } from "../../review/review-artifact.ts";
import type { CommandEvidence, FinalValidatorDependencies } from "../../review/validator.ts";
import { pathExists } from "../../shared/fs.ts";
import { runHostCommand } from "../../tools/host-runner.ts";
import type { AgentRunObserver } from "../agent-progress.ts";
import type { CommandOutcome } from "../command.ts";
import { defineChangeHandler } from "../handler.ts";
import { parseVerificationCommand } from "../../execution/verification-command.ts";
import { resolveModelStack } from "../models.ts";

export interface ProductionVerificationPorts {
  runCommand?(command: string, worktree: string, signal?: AbortSignal): Promise<CommandEvidence>;
}

export interface ProductionVerificationOptions {
  cwd: string;
  changeName: string;
  onAgentStart?: AgentRunObserver;
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
  const tasks = (await loadValidatedTaskDocument(tasksPath)).document.tasks;
  const run = openChangeRun(options.cwd, options.changeName);
  const manifest = await run.readManifest();
  const [taskResults, reviews, reports, checkpoints] = await Promise.all([
    run.readRecords("task-results", taskResultSchema),
    run.readRecords("reviews", reviewRecordSchema),
    run.readRecords("reports", dependencyReportSchema),
    run.readRecords("checkpoints", checkpointRecordSchema),
  ]);
  const git = new GitAdapter(manifest.worktree.path, undefined, undefined, options.signal);
  const [identity, gitStatus, worktrees, source] = await Promise.all([
    git.identity(),
    git.status(),
    git.worktrees(),
    readSourceDigest(git),
  ]);
  const head = { commit: source.head };
  const diff = source.diff;
  const sourceDigest = source.sourceDigest;
  const reviewPath = resolve(changeRoot, "review.md");
  const planningReview = await pathExists(reviewPath)
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
    // A task's passing evidence at this very source is not run again; everything else, and the full suite, is.
    const reusable = reusableCommands(tasks, taskResults, sourceDigest);
    commandEvidence = [];
    for (const command of commands) {
      const reusedDigest = reusable.get(command);
      commandEvidence.push(reusedDigest
        ? { command, exitCode: 0, reused: { sourceDigest: reusedDigest } }
        : await runCommand(command, manifest.worktree.path, options.signal));
    }
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
      manual: task.manual !== null,
    })),
    readEvidence: async () => ({ manifest, taskResults, reviews, checkpoints }),
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
      const available = await pathExists(designPath);
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
    runId: run.runId,
    store: run.store,
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
  const stack = resolveModelStack(options.argv);
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
