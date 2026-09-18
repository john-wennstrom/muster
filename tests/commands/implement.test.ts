import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ChangeSnapshot } from "../../src/controller/change-snapshot.ts";
import {
  implementChange,
  resumeChange,
  type ImplementChangeInput,
} from "../../src/controller/implement.ts";
import { createManualCheckpoint, loadManualCheckpoint } from "../../src/controller/manual-checkpoint.ts";
import { compileTaskDag } from "../../src/execution/delegation-dag.ts";
import { parseTaskDocument } from "../../src/execution/task-parser.ts";
import { runTaskPipeline } from "../../src/execution/task-runner.ts";
import type { ChangeWorktree } from "../../src/execution/worktree.ts";
import {
  changeResumeUsage,
  dispatchChangeCommand,
} from "../../src/runtime/change-command.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import type { CheckpointRecord } from "../../src/persistence/records.ts";

const temporaryDirectories: string[] = [];
const observedAt = "2026-09-12T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function snapshot(
  lifecycle: ChangeSnapshot["lifecycle"],
  pendingCheckpointIds: readonly string[] = [],
): ChangeSnapshot {
  return {
    changeName: "add-search",
    lifecycle,
    capturedAt: observedAt,
    observations: { openSpec: observedAt, repository: observedAt },
    digests: { artifact: "a", source: "b", head: "c", index: "d", diff: "e" },
    freshness: { review: "current", validation: "missing" },
    taskStates: { "1.1": false, "1.2": false },
    pendingCheckpointIds,
    discrepancies: [],
  };
}

function taskDocument(taskId: string): string {
  return `## 1. Implementation

- [ ] ${taskId} Implement task

  \`\`\`yaml harness-task
  id: "${taskId}"
  dependsOn: []
  role: builder
  reads: ["src/**"]
  writes: ["src/**"]
  requirements: ["change-workflows: Autonomous safe progression"]
  scenarios: ["Phase has no blockers"]
  verify: ["bun test"]
  manual: null
  \`\`\`
`;
}

async function fixture(): Promise<{
  root: string;
  store: AtomicJsonStore;
  worktree: ChangeWorktree;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "muster-implement-command-"));
  temporaryDirectories.push(root);
  const worktreePath = resolve(root, "worktrees", "add-search");
  await mkdir(worktreePath, { recursive: true });
  return {
    root,
    store: new AtomicJsonStore(resolve(root, ".fusion", "runs")),
    worktree: {
      repositoryId: "repo-1",
      commonDirectory: resolve(root, ".git"),
      path: worktreePath,
      branch: "muster/add-search",
      head: "a".repeat(40),
      reused: false,
    },
  };
}

function implementationInput(input: {
  root: string;
  worktree: ChangeWorktree;
  events: string[];
  checkpoint?: CheckpointRecord;
  independentComplete?: boolean;
}): ImplementChangeInput {
  const nodes = [
    { id: "1.1", dependsOn: [] as string[], checked: false },
    { id: "1.2", dependsOn: ["1.1"], checked: false },
    { id: "2.1", dependsOn: [] as string[], checked: input.independentComplete ?? false },
  ];
  const dag = compileTaskDag(nodes, "a".repeat(64), observedAt);
  return {
    changeName: "add-search",
    flow: {
      reviewFreshness: "current",
      recovery: {
        actions: input.checkpoint
          ? [{
            type: "restore_checkpoint",
            taskId: input.checkpoint.taskId,
            checkpointId: input.checkpoint.id,
          }]
          : [],
        discrepancies: [],
      },
      executeRecoveryAction: async (action) => {
        input.events.push(`recover:${action.type}`);
      },
      scheduler: {
        runId: "run-1",
        dag,
        tasks: {
          "1.1": { mode: "write", maxAttempts: 1 },
          "1.2": { mode: "write", maxAttempts: 1 },
          "2.1": { mode: "read", maxAttempts: 1 },
        },
        pendingCheckpoints: input.checkpoint ? [input.checkpoint] : [],
        worktree: {
          planningCwd: input.root,
          changeName: "add-search",
          worktreesRoot: resolve(input.root, "worktrees"),
        },
        selectWorktree: async () => {
          input.events.push("worktree");
          return input.worktree;
        },
        lease: { lockDirectory: resolve(input.root, "locks") },
        execute: async (scheduledTask) => {
          input.events.push(`schedule:${scheduledTask.id}`);
          const contents = taskDocument(scheduledTask.id);
          const pipeline = await runTaskPipeline({
            runId: "run-1",
            sessionsRoot: resolve(input.root, "sessions"),
            contents,
            task: parseTaskDocument(contents, "tasks.md").tasks[0]!,
            behaviorChanging: false,
            requirements: ["change-workflows: Autonomous safe progression"],
            scenarios: ["Phase has no blockers"],
            reviewBudgetAvailable: true,
            runBuilder: async () => {
              input.events.push(`builder:${scheduledTask.id}`);
              return { claim: "completed", implementationPersisted: true };
            },
            runVerification: async () => {
              input.events.push(`verify:${scheduledTask.id}`);
              return { passed: true, evidence: ["focused test passed"] };
            },
            runReview: async () => {
              input.events.push(`review:${scheduledTask.id}`);
              return { approved: true, findings: [] };
            },
            persistEvidence: async () => {
              input.events.push(`persist:${scheduledTask.id}`);
            },
          });
          return { outcome: pipeline.outcome.status };
        },
      },
      onDesignConflict: async () => undefined,
    },
  };
}

describe("change implement and resume commands", () => {
  test("runs the worktree scheduler and task pipeline to completion without extra confirmation", async () => {
    const { root, worktree } = await fixture();
    const events: string[] = [];
    let resultStatus = "";

    await dispatchChangeCommand("implement add-search", {
      ui: { notify: () => undefined },
    }, {
      resolveChangeName: async (explicit) => explicit ?? null,
      loadSnapshot: async () => snapshot("READY"),
      handlers: {
        implement: async (command) => {
          const result = await implementChange(implementationInput({ root, worktree, events }));
          resultStatus = result.status;
          expect(command.changeName).toBe("add-search");
        },
      },
    });

    expect(resultStatus).toBe("completed");
    expect(events[0]).toBe("worktree");
    const scheduled = events.filter((event) => event.startsWith("schedule:"));
    expect(scheduled.sort()).toEqual(["schedule:1.1", "schedule:1.2", "schedule:2.1"]);
    expect(events.indexOf("schedule:1.1")).toBeLessThan(events.indexOf("schedule:1.2"));
    for (const taskId of ["1.1", "1.2", "2.1"]) {
      expect(events).toContain(`builder:${taskId}`);
      expect(events).toContain(`verify:${taskId}`);
      expect(events).toContain(`review:${taskId}`);
      expect(events).toContain(`persist:${taskId}`);
    }
  });

  test("restores a pending branch without auto-resuming it while safe independent work proceeds", async () => {
    const { root, store, worktree } = await fixture();
    const checkpoint = await createManualCheckpoint({
      store,
      runId: "run-1",
      changeName: "add-search",
      taskId: "1.1",
      branch: ["1.1", "1.2"],
      category: "authentication",
      reason: "Authentication is required",
      instructions: ["Authenticate outside the agent channel"],
      resumeTarget: "1.1",
    });
    const events: string[] = [];
    const result = await implementChange(implementationInput({ root, worktree, events, checkpoint }));

    expect(result.status).toBe("paused");
    expect(result.scheduler?.states).toEqual({
      "1.1": "awaiting_user",
      "1.2": "blocked",
      "2.1": "completed",
    });
    expect(events).toContain("recover:restore_checkpoint");
    expect(events).toContain("schedule:2.1");
    expect(events).not.toContain("schedule:1.1");
    expect((await loadManualCheckpoint(store, "run-1", checkpoint.id)).status).toBe("pending");
  });

  test("resumes only the explicitly confirmed checkpoint and preserves task prerequisites", async () => {
    const { root, store, worktree } = await fixture();
    const checkpoint = await createManualCheckpoint({
      store,
      runId: "run-1",
      changeName: "add-search",
      taskId: "1.1",
      branch: ["1.1", "1.2"],
      category: "authentication",
      reason: "Authentication is required",
      instructions: ["Authenticate outside the agent channel"],
      resumeTarget: "1.1",
    });
    const events: string[] = [];
    let resumed: Awaited<ReturnType<typeof resumeChange>> | undefined;

    await dispatchChangeCommand(`resume add-search ${checkpoint.id}`, {
      ui: { notify: () => undefined },
    }, {
      resolveChangeName: async (explicit) => explicit ?? null,
      loadSnapshot: async () => snapshot("AWAITING_USER", [checkpoint.id]),
      handlers: {
        resume: async (command) => {
          resumed = await resumeChange({
            ...implementationInput({
              root,
              worktree,
              events,
              checkpoint,
              independentComplete: true,
            }),
            checkpointId: command.arguments[0]!,
            confirmedBy: "local-user",
            store,
            now: () => new Date("2026-09-12T13:00:00.000Z"),
          });
        },
      },
    });

    expect(resumed?.implementation.status).toBe("completed");
    expect(resumed?.checkpoint).toMatchObject({
      id: checkpoint.id,
      status: "confirmed",
      confirmedBy: "local-user",
      confirmedAt: "2026-09-12T13:00:00.000Z",
    });
    expect(events.filter((event) => event.startsWith("schedule:"))).toEqual([
      "schedule:1.1",
      "schedule:1.2",
    ]);
    expect(events).not.toContain("recover:restore_checkpoint");
  });

  test("rejects resume without exactly one checkpoint before loading state", async () => {
    const notifications: string[] = [];
    let snapshotsLoaded = 0;
    await dispatchChangeCommand("resume add-search", {
      ui: { notify: (message) => notifications.push(message) },
    }, {
      resolveChangeName: async (explicit) => explicit ?? null,
      loadSnapshot: async () => {
        snapshotsLoaded++;
        return snapshot("AWAITING_USER");
      },
      handlers: { resume: async () => undefined },
    });

    expect(snapshotsLoaded).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(changeResumeUsage);
    expect(notifications[0]).toContain("Status: blocked");
  });
});
