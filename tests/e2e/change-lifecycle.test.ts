import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classifyChange } from "../../src/controller/complexity-router.ts";
import { LANE_POLICY, laneOfClassification } from "../../src/controller/lane.ts";
import { planRecovery } from "../../src/controller/recovery.ts";
import { changeUsage } from "../../src/change/change-command.ts";
import type { CheckpointRecord } from "../../src/persistence/records.ts";
import { parseVerificationArtifact } from "../../src/review/verification-artifact.ts";
import { approveCurrentArtifacts, createHarness, fixtureNames, reachVerified, timestamp } from "../helpers/lifecycle-harness.ts";

describe("fixture-driven change lifecycle", () => {
  for (const fixtureName of fixtureNames) {
    test(`${fixtureName} progresses from status through VERIFIED`, async () => {
      const harness = await createHarness(fixtureName);
      const decision = classifyChange(harness.fixture);
      const policy = LANE_POLICY[laneOfClassification(decision.classification)];

      expect(decision.classification).toBe(harness.fixture.expectedComplexity);
      expect(harness.dag.topologicalOrder).toEqual(
        harness.parsed.tasks.map((task) => task.checkboxId),
      );
      expect(policy.debate).toBe(fixtureName === "architectural-change");

      await reachVerified(harness);
      expect(harness.archives).toEqual([]);

      if (fixtureName === "direct-change") {
        await harness.dispatch(`finish ${harness.fixture.changeName}`, {
          finish: async () => { await harness.runFinish(); },
        });
        expect(harness.archives).toEqual([harness.fixture.changeName]);
      }
    });
  }

  test("unknown subcommands show usage without resolving or mutating a change", async () => {
    const harness = await createHarness("direct-change");
    const before = structuredClone(harness.state.manifest);

    await harness.dispatch("unknown direct-change");

    expect(harness.notifications).toEqual([changeUsage]);
    expect(harness.events).toEqual([]);
    expect(harness.state.manifest).toEqual(before);
  });

  test("stale planning review blocks bounded implementation until re-review", async () => {
    const harness = await createHarness("bounded-change");
    harness.state.artifactDigest = "e".repeat(64);
    let implementationCalls = 0;

    await harness.dispatch("status bounded-change");
    expect(harness.notifications.at(-1)).toContain("Lifecycle: REVIEW_REQUIRED");
    await harness.dispatch("implement bounded-change", {
      implement: async () => { implementationCalls++; },
    });

    expect(implementationCalls).toBe(0);
    expect(harness.notifications.at(-1)).toContain("Next: /change review bounded-change");

    approveCurrentArtifacts(harness);
    await reachVerified(harness);
  });

  test("architectural design conflict stops dependents and requires refreshed planning", async () => {
    const harness = await createHarness("architectural-change");
    await harness.dispatch("status architectural-change");

    const conflicted = await harness.runImplementation({ conflictTaskId: "1.1" });
    expect(conflicted.status).toBe("design_conflict");
    expect(conflicted.scheduler?.states).toEqual({
      "1.1": "design_conflict",
      "1.2": "blocked",
    });
    expect(harness.snapshot().lifecycle).toBe("DESIGN_CONFLICT");
    expect(harness.events).toContain("design-conflict:1.1");

    harness.state.artifactDigest = "f".repeat(64);
    harness.state.manifest = {
      ...harness.state.manifest,
      artifactDigest: harness.state.artifactDigest,
      lifecycle: "READY",
      tasks: { "1.1": "ready", "1.2": "ready" },
    };
    approveCurrentArtifacts(harness);
    await reachVerified(harness);
  });

  test("restart restores a durable manual pause without dispatching its branch", async () => {
    const harness = await createHarness("bounded-change");
    const checkpoint: CheckpointRecord = {
      schemaVersion: 1,
      id: "checkpoint-fixture",
      runId: harness.state.manifest.runId,
      changeName: harness.fixture.changeName,
      taskId: "1.1",
      branch: ["1.1", "1.2"],
      category: "authentication",
      reason: "Authenticate outside the model-visible channel",
      instructions: ["Complete authentication in a trusted terminal"],
      createdAt: timestamp,
      status: "pending",
      resumeTarget: "1.1",
    };
    await harness.store.write(
      harness.state.manifest.runId,
      `checkpoints/${checkpoint.id}.json`,
      checkpoint,
    );
    harness.state.checkpoints = [checkpoint];
    harness.state.manifest = {
      ...harness.state.manifest,
      lifecycle: "AWAITING_USER",
      tasks: { "1.1": "awaiting_user", "1.2": "blocked" },
      checkpoints: [checkpoint.id],
    };
    const recovery = planRecovery({
      openSpec: {
        changeName: harness.fixture.changeName,
        artifactDigest: harness.state.artifactDigest,
        tasks: harness.state.tasks,
      },
      repository: {
        repositoryId: harness.state.manifest.repository.id,
        commonDirectory: harness.state.manifest.repository.commonDirectory,
        worktree: harness.worktreePath,
        worktreeExists: true,
        head: harness.state.manifest.worktree.head,
        indexDigest: harness.state.manifest.worktree.indexDigest,
        diffDigest: harness.state.manifest.worktree.diffDigest,
        sourceDigest: harness.state.sourceDigest,
      },
      manifest: harness.state.manifest,
      taskResults: [],
      reviews: [],
      checkpoints: harness.state.checkpoints,
      child: null,
      lease: null,
    });

    const result = await harness.runImplementation({ recovery });

    expect(recovery.actions).toEqual([{
      type: "restore_checkpoint",
      taskId: "1.1",
      checkpointId: checkpoint.id,
    }]);
    expect(result.status).toBe("paused");
    expect(result.scheduler?.states).toEqual({
      "1.1": "awaiting_user",
      "1.2": "blocked",
    });
    expect(harness.events).not.toContain("builder:1.1");
    await harness.dispatch("status bounded-change");
    expect(harness.notifications.at(-1)).toContain("Lifecycle: AWAITING_USER");
  });

  test("restart after task review synchronizes completion without rerunning agents", async () => {
    const harness = await createHarness("direct-change");
    harness.state.manifest = {
      ...harness.state.manifest,
      lifecycle: "IMPLEMENTING",
      tasks: { "1.1": "completed" },
    };
    harness.recordAcceptedTask("1.1");
    await harness.dispatch("status direct-change");
    expect(harness.notifications.at(-1)).toContain("Lifecycle: IMPLEMENTING");

    const recovery = planRecovery({
      openSpec: {
        changeName: harness.fixture.changeName,
        artifactDigest: harness.state.artifactDigest,
        tasks: harness.state.tasks,
      },
      repository: {
        repositoryId: harness.state.manifest.repository.id,
        commonDirectory: harness.state.manifest.repository.commonDirectory,
        worktree: harness.worktreePath,
        worktreeExists: true,
        head: harness.state.manifest.worktree.head,
        indexDigest: harness.state.manifest.worktree.indexDigest,
        diffDigest: harness.state.manifest.worktree.diffDigest,
        sourceDigest: harness.state.sourceDigest,
      },
      manifest: harness.state.manifest,
      taskResults: harness.state.taskResults,
      reviews: harness.state.taskReviews,
      checkpoints: [],
      child: null,
      lease: null,
    });
    const result = await harness.runImplementation({
      recovery,
      executeRecoveryAction: async (action) => {
        harness.events.push(`recover:${action.type}`);
        if (action.type === "synchronize_task_completion") {
          harness.state.tasks[action.taskId] = true;
        }
      },
    });

    expect(recovery.actions).toEqual([{
      type: "synchronize_task_completion",
      taskId: "1.1",
      sourceDigest: harness.state.sourceDigest,
    }]);
    expect(result.status).toBe("paused");
    expect(harness.events).not.toContain("worktree:selected");
    expect(harness.events.some((event) => event.startsWith("builder:"))).toBeFalse();
    expect(harness.snapshot().lifecycle).toBe("VERIFYING");

    await harness.runVerification();
    expect(harness.snapshot().lifecycle).toBe("VERIFIED");
    const artifact = parseVerificationArtifact(
      await readFile(resolve(harness.changeRoot, "verification.md"), "utf8"),
      resolve(harness.changeRoot, "verification.md"),
    );
    expect(artifact.result).toBe("PASS");
  });
});