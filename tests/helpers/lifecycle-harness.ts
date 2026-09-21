/**
 * The lifecycle harness: a fixture project driven through the change command with the controller's
 * ports replaced by in-memory state. Shared by the lifecycle scenarios in tests/e2e.
 */

import { afterEach, expect } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DependencyReport } from "../../src/agents/reports.ts";
import {
  createChangeSnapshot,
  type ChangeSnapshot,
} from "../../src/controller/change-snapshot.ts";
import {
  classifyChange,
  type ChangeComplexity,
  type ComplexityInput,
} from "../../src/controller/complexity-router.ts";
import { LANE_POLICY, laneOfClassification } from "../../src/controller/lane.ts";
import { finishChange } from "../../src/controller/finish.ts";
import { implementChange } from "../../src/controller/implement.ts";
import { planRecovery, type RecoveryPlan } from "../../src/controller/recovery.ts";
import { verifyChange } from "../../src/controller/verify.ts";
import { compileTaskDag } from "../../src/execution/delegation-dag.ts";
import { parseTaskDocument } from "../../src/execution/task-parser.ts";
import { validateTaskDocument } from "../../src/execution/task-schema.ts";
import { runTaskPipeline } from "../../src/execution/task-runner.ts";
import type { ChangeWorktree } from "../../src/execution/worktree.ts";
import {
  changeUsage,
  dispatchChangeCommand,
  type ChangeCommandDependencies,
} from "../../src/change/change-command.ts";
import type { OpenSpecArchive } from "../../src/openspec/protocol.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import type {
  CheckpointRecord,
  ReviewRecord,
  RunManifest,
  TaskResultRecord,
} from "../../src/persistence/records.ts";
import { createReviewArtifact } from "../../src/review/review-artifact.ts";
import type { FinalValidatorDependencies } from "../../src/review/validator.ts";
import { parseVerificationArtifact } from "../../src/review/verification-artifact.ts";

interface ProjectFixture extends ComplexityInput {
  changeName: string;
  expectedComplexity: ChangeComplexity;
}

const fixtureRoot = resolve(import.meta.dir, "../fixtures/projects");
export const fixtureNames = ["direct-change", "bounded-change", "architectural-change"] as const;
export const timestamp = "2026-09-12T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function loadFixture(name: typeof fixtureNames[number]) {
  const root = resolve(fixtureRoot, name);
  const fixture = JSON.parse(await readFile(resolve(root, "project.json"), "utf8")) as ProjectFixture;
  const tasksContents = await readFile(resolve(root, "tasks.md"), "utf8");
  const parsedDocument = parseTaskDocument(tasksContents, resolve(root, "tasks.md"));
  const references = (field: "requirements" | "scenarios"): Set<string> => new Set(
    parsedDocument.tasks.flatMap((task) => {
      const values = task.metadata[field];
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new TypeError(`Fixture task ${task.checkboxId} has invalid ${field}`);
      }
      return values as string[];
    }),
  );
  const parsed = validateTaskDocument(parsedDocument, {
    requirements: references("requirements"),
    scenarios: references("scenarios"),
  });
  const dag = compileTaskDag(
    parsed.tasks.map((task) => ({
      id: task.checkboxId,
      dependsOn: task.dependsOn,
      checked: task.checked,
    })),
    "a".repeat(64),
    timestamp,
  );
  return { fixture, parsed, dag, root, tasksContents };
}

export type LoadedFixture = Awaited<ReturnType<typeof loadFixture>>;

interface HarnessState {
  artifactDigest: string;
  sourceDigest: string;
  tasks: Record<string, boolean>;
  manifest: RunManifest;
  review: ReturnType<typeof createReviewArtifact>;
  validation: { result: "PASS" | "FAIL"; artifactDigest: string; sourceDigest: string } | null;
  checkpoints: CheckpointRecord[];
  taskResults: TaskResultRecord[];
  taskReviews: ReviewRecord[];
  reports: DependencyReport[];
}

export async function createHarness(fixtureName: typeof fixtureNames[number]) {
  const loaded = await loadFixture(fixtureName);
  const root = await mkdtemp(resolve(tmpdir(), `muster-e2e-${fixtureName}-`));
  temporaryDirectories.push(root);
  const changeRoot = resolve(root, "openspec", "changes", loaded.fixture.changeName);
  const worktreePath = resolve(root, "worktrees", loaded.fixture.changeName);
  const commonDirectory = resolve(root, ".git");
  await mkdir(changeRoot, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await copyFile(resolve(loaded.root, "tasks.md"), resolve(changeRoot, "tasks.md"));

  const digestCharacters = { direct: "a", bounded: "b", architectural: "c" } as const;
  const artifactDigest = digestCharacters[loaded.fixture.expectedComplexity].repeat(64);
  const sourceDigest = String.fromCharCode(
    digestCharacters[loaded.fixture.expectedComplexity].charCodeAt(0) + 3,
  ).repeat(64);
  const head = "1".repeat(40);
  const runId = `run-${loaded.fixture.changeName}`;
  const taskStates = Object.fromEntries(loaded.parsed.tasks.map((task) => [task.checkboxId, false]));
  const state: HarnessState = {
    artifactDigest,
    sourceDigest,
    tasks: taskStates,
    manifest: {
      schemaVersion: 1,
      runId,
      changeName: loaded.fixture.changeName,
      lifecycle: "READY",
      repository: { id: "fixture-repository", commonDirectory },
      worktree: {
        path: worktreePath,
        head,
        indexDigest: "index-clean",
        diffDigest: "diff-fixture",
      },
      artifactDigest,
      tasks: Object.fromEntries(loaded.parsed.tasks.map((task) => [task.checkboxId, "ready"])),
      modelAssignments: {},
      writer: null,
      checkpoints: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    review: createReviewArtifact({
      schemaVersion: 1,
      round: 1,
      reviewedAt: timestamp,
      model: "fixture/planning-reviewer",
      artifactDigest,
      requestedVerdict: "APPROVE",
      criticalFindings: [],
      requiredChanges: [],
      recommendations: [],
    }),
    validation: null,
    checkpoints: [],
    taskResults: [],
    taskReviews: [],
    reports: [],
  };
  const notifications: string[] = [];
  const events: string[] = [];
  const archives: string[] = [];
  const store = new AtomicJsonStore(resolve(root, ".fusion", "runs"));
  const worktree: ChangeWorktree = {
    repositoryId: state.manifest.repository.id,
    commonDirectory,
    path: worktreePath,
    branch: `muster/${loaded.fixture.changeName}`,
    head,
    reused: true,
  };

  const snapshot = (): ChangeSnapshot => createChangeSnapshot({
    capturedAt: timestamp,
    openSpec: {
      observedAt: timestamp,
      changeName: loaded.fixture.changeName,
      planningComplete: true,
      tasks: state.tasks,
      artifactDigest: state.artifactDigest,
    },
    repository: {
      observedAt: timestamp,
      repositoryId: state.manifest.repository.id,
      commonDirectory,
      worktree: worktreePath,
      head,
      indexDigest: state.manifest.worktree.indexDigest,
      diffDigest: state.manifest.worktree.diffDigest,
      sourceDigest: state.sourceDigest,
    },
    runtime: { observedAt: timestamp, manifest: state.manifest },
    review: { observedAt: timestamp, artifact: state.review },
    validation: state.validation ? { observedAt: timestamp, ...state.validation } : null,
    pendingCheckpointIds: state.checkpoints
      .filter((checkpoint) => checkpoint.status === "pending")
      .map((checkpoint) => checkpoint.id),
  });

  const dispatch = async (
    raw: string,
    handlers: ChangeCommandDependencies["handlers"] = {},
  ): Promise<void> => dispatchChangeCommand(raw, {
    ui: { notify: (message) => notifications.push(message) },
  }, {
    resolveChangeName: async (explicit) => explicit ?? loaded.fixture.changeName,
    loadSnapshot: async () => snapshot(),
    handlers,
  });

  const recordAcceptedTask = (taskId: string): void => {
    if (!state.taskResults.some((record) => record.taskId === taskId)) {
      state.taskResults.push({
        schemaVersion: 1,
        runId,
        taskId,
        outcome: "completed",
        sourceDigest: state.sourceDigest,
        verificationEvidence: [`${taskId}: focused verification passed`],
        completedAt: timestamp,
      });
      state.taskReviews.push({
        schemaVersion: 1,
        runId,
        taskId,
        kind: "task",
        verdict: "APPROVE",
        artifactDigest: state.sourceDigest,
        model: "fixture/task-reviewer",
        findings: [],
        createdAt: timestamp,
      });
      state.reports.push({
        schemaVersion: 1,
        runId,
        taskId,
        outcome: "completed",
        summary: `${taskId} completed and reviewed`,
        changedInterfaces: [],
        evidence: [`${taskId}: focused verification passed`],
        createdAt: timestamp,
      });
    }
  };

  const runImplementation = async (options: {
    conflictTaskId?: string;
    recovery?: RecoveryPlan;
    executeRecoveryAction?: (action: RecoveryPlan["actions"][number]) => Promise<void>;
  } = {}) => {
    const result = await implementChange({
      changeName: loaded.fixture.changeName,
      flow: {
        reviewFreshness: snapshot().freshness.review,
        recovery: options.recovery ?? { actions: [], discrepancies: [] },
        executeRecoveryAction: options.executeRecoveryAction ?? (async (action) => {
          events.push(`recover:${action.type}`);
        }),
        scheduler: {
          runId,
          dag: loaded.dag,
          tasks: Object.fromEntries(loaded.parsed.tasks.map((task) => [
            task.checkboxId,
            { mode: "write" as const, maxAttempts: 1 },
          ])),
          pendingCheckpoints: state.checkpoints,
          worktree: {
            planningCwd: root,
            changeName: loaded.fixture.changeName,
            worktreesRoot: resolve(root, "worktrees"),
          },
          selectWorktree: async () => {
            events.push("worktree:selected");
            return worktree;
          },
          lease: { lockDirectory: resolve(root, "locks") },
          execute: async (scheduledTask) => {
            events.push(`builder:${scheduledTask.id}`);
            const parsedTask = loaded.parsed.tasks.find(
              (task) => task.checkboxId === scheduledTask.id,
            )!;
            const pipeline = await runTaskPipeline({
              runId,
              sessionsRoot: resolve(root, ".fusion", "sessions"),
              contents: loaded.tasksContents,
              task: {
                ...parsedTask,
                metadata: {
                  id: parsedTask.id,
                  dependsOn: parsedTask.dependsOn,
                  role: parsedTask.role,
                  reads: parsedTask.reads,
                  writes: parsedTask.writes,
                  requirements: parsedTask.requirements,
                  scenarios: parsedTask.scenarios,
                  verify: parsedTask.verify,
                  manual: parsedTask.manual,
                },
              },
              behaviorChanging: false,
              requirements: parsedTask.requirements,
              scenarios: parsedTask.scenarios,
              reviewBudgetAvailable: true,
              runBuilder: async () => options.conflictTaskId === scheduledTask.id
                ? {
                    claim: "design_conflict",
                    implementationPersisted: false,
                    conflict: {
                      evidence: ["Fixture repository contradicts the approved boundary"],
                      affectedArtifacts: ["design.md"],
                      affectedTasks: [scheduledTask.id],
                    },
                  }
                : { claim: "completed", implementationPersisted: true },
              runVerification: async () => ({
                passed: true,
                evidence: [`${scheduledTask.id}: focused verification passed`],
              }),
              runReview: async () => ({ approved: true, findings: [] }),
              persistEvidence: async () => recordAcceptedTask(scheduledTask.id),
            });
            return { outcome: pipeline.outcome.status };
          },
        },
        onDesignConflict: async (taskIds) => {
          events.push(`design-conflict:${taskIds.join(",")}`);
        },
      },
    });

    if (result.scheduler) {
      state.manifest = {
        ...state.manifest,
        lifecycle: result.status === "design_conflict" ? "DESIGN_CONFLICT" : "IMPLEMENTING",
        tasks: Object.fromEntries(Object.entries(result.scheduler.states).map(
          ([taskId, taskState]) => [taskId, taskState === "pending" ? "ready" : taskState],
        )) as RunManifest["tasks"],
      };
      if (result.status === "completed") {
        state.tasks = Object.fromEntries(Object.keys(state.tasks).map((taskId) => [taskId, true]));
      }
    }
    return result;
  };

  const validatorDependencies = (): FinalValidatorDependencies => ({
    readOpenSpec: async () => ({
      status: {
        changeName: loaded.fixture.changeName,
        schemaName: "fusion-driven",
        planningHome: {
          kind: "repo",
          root,
          changesDir: resolve(root, "openspec", "changes"),
          defaultSchema: "fusion-driven",
        },
        changeRoot,
        artifactPaths: {},
        isPlanningComplete: true,
        isComplete: true,
        applyRequires: ["review"],
        nextSteps: [],
        actionContext: {
          mode: "repo-local",
          sourceOfTruth: "repo",
          planningArtifacts: ["proposal", "specs", "design", "tasks"],
          linkedContext: [],
          allowedEditRoots: [root],
          requiresAffectedAreaSelection: false,
          constraints: [],
        },
        artifacts: [
          { id: "tasks", outputPath: "tasks.md", status: "done", requires: [] },
        ],
        root: { path: root, source: "nearest" },
      },
      apply: {
        changeName: loaded.fixture.changeName,
        changeDir: changeRoot,
        schemaName: "fusion-driven",
        contextFiles: { tasks: [resolve(changeRoot, "tasks.md")] },
        progress: {
          total: loaded.parsed.tasks.length,
          complete: Object.values(state.tasks).filter(Boolean).length,
          remaining: Object.values(state.tasks).filter((done) => !done).length,
        },
        tasks: loaded.parsed.tasks.map((task, index) => ({
          id: String(index + 1),
          description: `${task.checkboxId} ${task.description}`,
          done: state.tasks[task.checkboxId]!,
        })),
        state: Object.values(state.tasks).every(Boolean) ? "all_done" : "ready",
        instruction: "Fixture apply state",
        root: { path: root, source: "nearest" },
      },
      validation: {
        items: [{ id: loaded.fixture.changeName, type: "change", valid: true, issues: [] }],
        summary: {
          totals: { items: 1, passed: 1, failed: 0 },
          byType: { change: { items: 1, passed: 1, failed: 0 } },
        },
        version: "fixture-1",
        root: { path: root, source: "nearest" },
      },
      artifactDigest: state.artifactDigest,
    }),
    readTasks: async () => loaded.parsed.tasks.map((task) => ({
      id: task.checkboxId,
      done: state.tasks[task.checkboxId]!,
      requirements: task.requirements,
      scenarios: task.scenarios,
      verify: task.verify,
    })),
    readEvidence: async () => ({
      manifest: state.manifest,
      taskResults: state.taskResults,
      reviews: state.taskReviews,
    }),
    runTests: async () => ({
      focused: loaded.parsed.tasks.flatMap((task) =>
        task.verify.map((command) => ({ command, exitCode: 0 }))
      ),
      fullSuite: { command: "bun test", exitCode: 0 },
    }),
    readFindings: async () => ({ unresolved: [] }),
    checkDesign: async () => ({
      available: true,
      aligned: true,
      evidence: [`${loaded.fixture.expectedComplexity} fixture design is aligned`],
    }),
    readFreshness: async () => ({
      artifactDigest: state.artifactDigest,
      sourceDigest: state.sourceDigest,
      planningReviewDigest: state.review.artifactDigest,
      staleInputs: [],
    }),
    readReports: async () => ({ reports: state.reports }),
    readRepository: async () => ({
      repositoryId: state.manifest.repository.id,
      commonDirectory,
      worktreePath,
      head,
      status: [],
      worktrees: [{
        path: worktreePath,
        head,
        branch: `refs/heads/muster/${loaded.fixture.changeName}`,
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
      }],
      sourceDigest: state.sourceDigest,
      writerActive: false,
      pendingCheckpointIds: [],
      discrepancies: [],
    }),
    now: () => timestamp,
  });

  const runVerification = async () => {
    const result = await verifyChange({
      changeName: loaded.fixture.changeName,
      changeRoot,
      validation: {
        runId,
        changeName: loaded.fixture.changeName,
        sessionsRoot: resolve(root, ".fusion", "sessions"),
        dependencies: validatorDependencies(),
      },
      summary: {
        model: "fixture/final-validator",
        artifactDigest: state.artifactDigest,
        sourceDigest: state.sourceDigest,
        repositoryState: { kind: "diff", identity: state.manifest.worktree.diffDigest },
        commands: [{ command: "bun test", exitCode: 0, evidenceLinks: [] }],
        requirementEvidence: loaded.parsed.tasks.map((task) => ({
          requirement: task.requirements[0]!,
          scenario: task.scenarios[0]!,
          evidenceLinks: [{ label: "fixture E2E", href: "tests/e2e/change-lifecycle.test.ts" }],
        })),
        findings: [],
        deviations: [],
        warnings: [],
      },
    });
    state.validation = {
      result: result.validation.result,
      artifactDigest: result.artifact.artifactDigest,
      sourceDigest: result.artifact.sourceDigest,
    };
    return result;
  };

  const runFinish = async () => finishChange({
    changeName: loaded.fixture.changeName,
    changeRoot,
  }, {
    readCurrentDigests: async () => ({
      artifactDigest: state.artifactDigest,
      sourceDigest: state.sourceDigest,
    }),
    archive: async (changeName): Promise<OpenSpecArchive> => {
      archives.push(changeName);
      return {
        archive: {
          change: changeName,
          archivedAs: `2026-09-12-${changeName}`,
          path: resolve(root, "openspec", "changes", "archive", `2026-09-12-${changeName}`),
          specsUpdated: [],
        },
        root: { path: root, source: "nearest" },
      };
    },
  });

  return {
    ...loaded,
    root,
    changeRoot,
    worktreePath,
    state,
    store,
    notifications,
    events,
    archives,
    snapshot,
    dispatch,
    recordAcceptedTask,
    runImplementation,
    runVerification,
    runFinish,
  };
}

export function approveCurrentArtifacts(harness: Awaited<ReturnType<typeof createHarness>>): void {
  harness.state.review = createReviewArtifact({
    schemaVersion: 1,
    round: harness.state.review.round + 1,
    reviewedAt: timestamp,
    model: "fixture/planning-reviewer",
    artifactDigest: harness.state.artifactDigest,
    requestedVerdict: "APPROVE",
    criticalFindings: [],
    requiredChanges: [],
    recommendations: [],
  });
}

export async function reachVerified(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  await harness.dispatch(`status ${harness.fixture.changeName}`);
  expect(harness.notifications.at(-1)).toContain("Lifecycle: READY");

  let implementationStatus = "";
  await harness.dispatch(`implement ${harness.fixture.changeName}`, {
    implement: async () => {
      implementationStatus = (await harness.runImplementation()).status;
    },
  });
  expect(implementationStatus).toBe("completed");
  expect(harness.snapshot().lifecycle).toBe("VERIFYING");

  await harness.dispatch(`verify ${harness.fixture.changeName}`, {
    verify: async () => {
      const result = await harness.runVerification();
      expect(result.validation.readiness).toBe("READY_TO_FINISH");
    },
  });
  await harness.dispatch(`status ${harness.fixture.changeName}`);
  expect(harness.notifications.at(-1)).toContain("Lifecycle: VERIFIED");
  expect(harness.snapshot().lifecycle).toBe("VERIFIED");
}
