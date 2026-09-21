import { describe, expect, test } from "bun:test";
import type { DependencyReport } from "../../src/agents/reports.ts";
import type { GitWorktree } from "../../src/execution/git.ts";
import type {
  CheckpointRecord,
  ReviewRecord,
  RunManifest,
  TaskResultRecord,
} from "../../src/persistence/records.ts";
import {
  finalValidationResultSchema,
  runFinalValidation,
  type FinalValidationContext,
  type FinalValidatorDependencies,
} from "../../src/review/validator.ts";

const timestamp = "2026-09-12T12:00:00.000Z";
const artifactDigest = "a".repeat(64);
const sourceDigest = "b".repeat(64);
const head = "c".repeat(40);
const taskDescription = "1.1 Build the feature";

const manifest: RunManifest = {
  schemaVersion: 1,
  runId: "run-1",
  changeName: "add-search",
  lifecycle: "VERIFYING",
  repository: { id: "repo-1", commonDirectory: "/repo/.git" },
  worktree: {
    path: "/repo-worktrees/add-search",
    head,
    indexDigest: "index",
    diffDigest: "diff",
  },
  artifactDigest,
  tasks: { "1.1": "completed" },
  modelAssignments: { builder: "openai/builder" },
  writer: null,
  checkpoints: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};

const taskResult: TaskResultRecord = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "1.1",
  outcome: "completed",
  sourceDigest,
  verificationEvidence: ["bun test tests/feature.test.ts: pass"],
  completedAt: timestamp,
};

const taskReview: ReviewRecord = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "1.1",
  kind: "task",
  verdict: "APPROVE",
  artifactDigest: sourceDigest,
  model: "openai/reviewer",
  findings: [],
  createdAt: timestamp,
};

const report: DependencyReport = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "1.1",
  outcome: "completed",
  summary: "Implemented and reviewed.",
  changedInterfaces: ["feature"],
  evidence: ["bun test tests/feature.test.ts: pass"],
  createdAt: timestamp,
};

const worktree: GitWorktree = {
  path: "/repo-worktrees/add-search",
  head,
  branch: "refs/heads/muster/add-search",
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
};

function dependencies(contexts: FinalValidationContext[]): FinalValidatorDependencies {
  const record = <T>(value: T) => async (context: FinalValidationContext): Promise<T> => {
    contexts.push(context);
    return value;
  };
  return {
    readOpenSpec: record({
      status: {
        changeName: "add-search",
        schemaName: "fusion-driven",
        planningHome: {
          kind: "repo",
          root: "/repo",
          changesDir: "/repo/openspec/changes",
          defaultSchema: "fusion-driven",
        },
        changeRoot: "/repo/openspec/changes/add-search",
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
          allowedEditRoots: ["/repo"],
          requiresAffectedAreaSelection: false,
          constraints: [],
        },
        artifacts: [
          { id: "proposal", outputPath: "proposal.md", status: "done", requires: [] },
          { id: "tasks", outputPath: "tasks.md", status: "done", requires: ["design"] },
        ],
        root: { path: "/repo", source: "nearest" },
      },
      apply: {
        changeName: "add-search",
        changeDir: "/repo/openspec/changes/add-search",
        schemaName: "fusion-driven",
        contextFiles: {},
        progress: { total: 1, complete: 1, remaining: 0 },
        tasks: [{ id: "1", description: taskDescription, done: true }],
        state: "all_done",
        instruction: "All tasks complete.",
        root: { path: "/repo", source: "nearest" },
      },
      validation: {
        items: [{ id: "add-search", type: "change", valid: true, issues: [] }],
        summary: {
          totals: { items: 1, passed: 1, failed: 0 },
          byType: { change: { items: 1, passed: 1, failed: 0 } },
        },
        version: "1.0.0",
        root: { path: "/repo", source: "nearest" },
      },
      artifactDigest,
    }),
    readTasks: record([{
      id: "1.1",
      done: true,
      requirements: ["search: Query support"],
      scenarios: ["Search succeeds"],
      verify: ["bun test tests/feature.test.ts"],
    }]),
    readEvidence: record({ manifest, taskResults: [taskResult], reviews: [taskReview] }),
    runTests: record({
      focused: [{ command: "bun test tests/feature.test.ts", exitCode: 0 }],
      fullSuite: { command: "bun test", exitCode: 0 },
    }),
    readFindings: record({ unresolved: [] }),
    checkDesign: record({ available: true, aligned: true, evidence: ["design decision 3 satisfied"] }),
    readFreshness: record({
      artifactDigest,
      sourceDigest,
      planningReviewDigest: artifactDigest,
      staleInputs: [],
    }),
    readReports: record({ reports: [report] }),
    readRepository: record({
      repositoryId: "repo-1",
      commonDirectory: "/repo/.git",
      worktreePath: "/repo-worktrees/add-search",
      head,
      status: [],
      worktrees: [worktree],
      sourceDigest,
      writerActive: false,
      pendingCheckpointIds: [],
      discrepancies: [],
    }),
    now: () => timestamp,
  };
}

function options(deps: FinalValidatorDependencies) {
  return {
    runId: "run-1",
    changeName: "add-search",
    sessionsRoot: "/tmp/muster-sessions",
    dependencies: deps,
    builderClaims: ["all implementation and tests passed"],
  };
}

describe("final validator", () => {
  test("uses a fresh read-only context and returns readiness only when every gate passes", async () => {
    const firstContexts: FinalValidationContext[] = [];
    const secondContexts: FinalValidationContext[] = [];

    const first = await runFinalValidation(options(dependencies(firstContexts)));
    const second = await runFinalValidation(options(dependencies(secondContexts)));

    expect(first).toMatchObject({ result: "PASS", readiness: "READY_TO_FINISH", access: "read" });
    expect(first.checks.map((item) => item.gate)).toEqual([
      "openspec",
      "tasks",
      "evidence",
      "tests",
      "findings",
      "design",
      "freshness",
      "reports",
      "repository",
    ]);
    expect(firstContexts).toHaveLength(9);
    expect(firstContexts.every((context) => context.access === "read")).toBeTrue();
    expect(new Set(firstContexts.map((context) => context.sessionId))).toEqual(new Set([first.sessionId]));
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  test("blocks readiness when the full suite fails despite successful builder claims", async () => {
    const deps = dependencies([]);
    deps.runTests = async () => ({
      focused: [{ command: "bun test tests/feature.test.ts", exitCode: 0 }],
      fullSuite: { command: "bun test", exitCode: 1 },
    });

    const result = await runFinalValidation(options(deps));

    expect(result).toMatchObject({ result: "FAIL", readiness: "BLOCKED" });
    expect(result.checks.find((item) => item.gate === "tests")).toMatchObject({ status: "FAIL" });
    expect(result.blockingReasons).toContain("tests: Required full test suite failed: bun test");
  });

  test("blocks stale and missing required inputs", async () => {
    const stale = dependencies([]);
    stale.readFreshness = async () => ({
      artifactDigest,
      sourceDigest,
      planningReviewDigest: "d".repeat(64),
      staleInputs: ["task review evidence predates the current source"],
    });
    const staleResult = await runFinalValidation(options(stale));
    expect(staleResult.readiness).toBe("BLOCKED");
    expect(staleResult.checks.find((item) => item.gate === "freshness")).toMatchObject({ status: "FAIL" });

    const missing = dependencies([]);
    missing.checkDesign = async () => {
      throw new Error("design.md not found");
    };
    const missingResult = await runFinalValidation(options(missing));
    expect(missingResult.readiness).toBe("BLOCKED");
    expect(missingResult.blockingReasons).toContain(
      "design: Required design input is unavailable: design.md not found",
    );
  });

  test("exposes a strict structured result contract", async () => {
    const result = await runFinalValidation(options(dependencies([])));

    expect(finalValidationResultSchema.safeParse({ ...result, transcript: "not allowed" }).success).toBeFalse();
  });
});
describe("final validator and planned manual tasks", () => {
  const manualTask = {
    id: "1.1",
    done: true,
    requirements: ["search: Query support"],
    scenarios: ["Search succeeds"],
    verify: ["bun test tests/feature.test.ts"],
    manual: true,
  };
  const confirmed: CheckpointRecord = {
    schemaVersion: 1,
    id: "checkpoint-1",
    runId: "run-1",
    changeName: "add-search",
    taskId: "1.1",
    branch: ["1.1"],
    category: "design_decision",
    reason: "The owner must confirm the wording",
    instructions: ["Confirm the labels"],
    createdAt: timestamp,
    status: "confirmed",
    resumeTarget: "1.1",
    confirmedAt: timestamp,
    confirmedBy: "owner",
  };
  const manualResult: TaskResultRecord = {
    ...taskResult,
    verificationEvidence: ["manual checkpoint checkpoint-1 confirmed by owner"],
  };

  const withManual = (checkpoints: readonly CheckpointRecord[]): FinalValidatorDependencies => ({
    ...dependencies([]),
    readTasks: async () => [manualTask],
    readEvidence: async () => ({ manifest, taskResults: [manualResult], reviews: [], checkpoints }),
  });

  test("a confirmed checkpoint stands in for the builder's review", async () => {
    const result = await runFinalValidation(options(withManual([confirmed])));
    expect(result.checks.find((check) => check.gate === "evidence")).toMatchObject({ status: "PASS" });
    expect(result.result).toBe("PASS");
  });

  test("a manual task with no confirmed checkpoint fails the evidence gate", async () => {
    const result = await runFinalValidation(options(withManual([])));
    const evidence = result.checks.find((check) => check.gate === "evidence");
    expect(evidence).toMatchObject({ status: "FAIL" });
    expect(evidence?.summary).toContain("Manual task 1.1 has no confirmed checkpoint");
  });

  test("a pending checkpoint does not count", async () => {
    const { confirmedAt: _at, confirmedBy: _by, ...rest } = confirmed;
    const result = await runFinalValidation(options(withManual([{ ...rest, status: "pending" }])));
    expect(result.checks.find((check) => check.gate === "evidence")).toMatchObject({ status: "FAIL" });
  });

  test("a builder task still needs its approved review", async () => {
    const result = await runFinalValidation(options({
      ...withManual([confirmed]),
      readTasks: async () => [{ ...manualTask, manual: false }],
    }));
    expect(result.checks.find((check) => check.gate === "evidence")).toMatchObject({ status: "FAIL" });
  });
});
