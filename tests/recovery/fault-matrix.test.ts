import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  planRecovery,
  type RecoveryAction,
  type RecoveryInput,
} from "../../src/controller/recovery.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import type {
  CheckpointRecord,
  ReviewRecord,
  RunManifest,
  TaskResultRecord,
} from "../../src/persistence/records.ts";
import {
  DeterministicFaultInjector,
  InjectedFault,
} from "../helpers/fault-injection.ts";

const timestamp = "2026-09-12T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

const baseManifest: RunManifest = {
  schemaVersion: 1,
  runId: "run-1",
  changeName: "add-search",
  lifecycle: "IMPLEMENTING",
  repository: { id: "repo-1", commonDirectory: "/repo/.git" },
  worktree: {
    path: "/repo-worktrees/add-search",
    head: "a".repeat(40),
    indexDigest: "index-before",
    diffDigest: "diff-before",
  },
  artifactDigest: "artifacts-current",
  tasks: { "1.1": "ready" },
  modelAssignments: { builder: "openai/example" },
  writer: null,
  checkpoints: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};

const completedResult: TaskResultRecord = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "1.1",
  outcome: "completed",
  sourceDigest: "source-after-write",
  verificationEvidence: ["bun test tests/recovery"],
  completedAt: timestamp,
};

const acceptedReview: ReviewRecord = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "1.1",
  kind: "task",
  verdict: "APPROVE",
  artifactDigest: "source-after-write",
  model: "openai/reviewer",
  findings: [],
  createdAt: timestamp,
};

function recoveryInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    openSpec: {
      changeName: "add-search",
      artifactDigest: "artifacts-current",
      tasks: { "1.1": false },
    },
    repository: {
      repositoryId: "repo-1",
      commonDirectory: "/repo/.git",
      worktree: "/repo-worktrees/add-search",
      worktreeExists: true,
      head: "a".repeat(40),
      indexDigest: "index-before",
      diffDigest: "diff-before",
      sourceDigest: "source-before",
    },
    manifest: baseManifest,
    taskResults: [],
    reviews: [],
    checkpoints: [],
    child: null,
    lease: null,
    ...overrides,
  };
}

interface FaultCase {
  point: string;
  input: RecoveryInput;
  expected: RecoveryAction;
}

const sourceChanged = {
  ...recoveryInput().repository,
  diffDigest: "diff-after-write",
  sourceDigest: "source-after-write",
};

const checkpoint: CheckpointRecord = {
  schemaVersion: 1,
  id: "checkpoint-1",
  runId: "run-1",
  changeName: "add-search",
  taskId: "1.1",
  branch: ["1.1"],
  category: "authentication",
  reason: "Authentication required",
  instructions: ["Authenticate outside the agent session"],
  createdAt: timestamp,
  status: "pending",
  resumeTarget: "1.1",
};

const faultCases: FaultCase[] = [
  {
    point: "before_builder_start",
    input: recoveryInput(),
    expected: { type: "rerun_builder", taskId: "1.1" },
  },
  {
    point: "during_builder_execution",
    input: recoveryInput({
      manifest: {
        ...baseManifest,
        tasks: { "1.1": "running" },
        writer: {
          processId: 42,
          runId: "run-1",
          taskId: "1.1",
          command: "builder",
          acquiredAt: timestamp,
        },
      },
      child: { status: "running", processId: 42, runId: "run-1", taskId: "1.1" },
      lease: {
        status: "live",
        processId: 42,
        runId: "run-1",
        taskId: "1.1",
        repositoryId: "repo-1",
        worktree: "/repo-worktrees/add-search",
      },
    }),
    expected: { type: "wait_for_child", taskId: "1.1", processId: 42 },
  },
  {
    point: "before_task_review",
    input: recoveryInput({
      repository: sourceChanged,
      manifest: { ...baseManifest, tasks: { "1.1": "running" } },
      taskResults: [completedResult],
    }),
    expected: {
      type: "resume_task_review",
      taskId: "1.1",
      sourceDigest: "source-after-write",
    },
  },
  {
    point: "after_passing_task_review",
    input: recoveryInput({
      repository: sourceChanged,
      manifest: { ...baseManifest, tasks: { "1.1": "completed" } },
      taskResults: [completedResult],
      reviews: [acceptedReview],
    }),
    expected: {
      type: "synchronize_task_completion",
      taskId: "1.1",
      sourceDigest: "source-after-write",
    },
  },
  {
    point: "before_final_verification",
    input: recoveryInput({
      openSpec: {
        changeName: "add-search",
        artifactDigest: "artifacts-current",
        tasks: { "1.1": true },
      },
      manifest: { ...baseManifest, tasks: { "1.1": "completed" } },
    }),
    expected: { type: "resume_final_verification" },
  },
  {
    point: "awaiting_user",
    input: recoveryInput({
      manifest: {
        ...baseManifest,
        lifecycle: "AWAITING_USER",
        tasks: { "1.1": "awaiting_user" },
        checkpoints: ["checkpoint-1"],
      },
      checkpoints: [checkpoint],
    }),
    expected: {
      type: "restore_checkpoint",
      taskId: "1.1",
      checkpointId: "checkpoint-1",
    },
  },
];

describe("recovery fault matrix", () => {
  for (const faultCase of faultCases) {
    test(`recovers ${faultCase.point} deterministically without mutating evidence`, () => {
      const before = structuredClone(faultCase.input);

      const first = planRecovery(faultCase.input);
      const second = planRecovery(faultCase.input);

      expect(first).toEqual(second);
      expect(first.actions).toContainEqual(faultCase.expected);
      expect(faultCase.input).toEqual(before);
    });
  }

  test("preserves the previous manifest when interrupted during an atomic transition", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-recovery-fault-"));
    temporaryDirectories.push(root);
    const injector = new DeterministicFaultInjector("during_state_write");
    const store = new AtomicJsonStore(resolve(root, ".fusion/runs"), {
      beforeRename: () => injector.inject("during_state_write"),
    });
    const previous = { schemaVersion: 1, state: "ready" };
    const target = resolve(root, ".fusion/runs/run-1/manifest.json");
    const initialStore = new AtomicJsonStore(resolve(root, ".fusion/runs"));
    await initialStore.write("run-1", "manifest.json", previous);

    await expect(
      store.write("run-1", "manifest.json", { schemaVersion: 1, state: "running" }),
    ).rejects.toBeInstanceOf(InjectedFault);

    expect(injector.didTrigger).toBeTrue();
    expect(await initialStore.read("run-1", "manifest.json")).toEqual(previous);
    expect(target.endsWith(".fusion/runs/run-1/manifest.json")).toBeTrue();
  });
});