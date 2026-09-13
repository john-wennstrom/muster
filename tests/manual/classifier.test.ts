import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  checkpointPlannedManualAction,
  createManualCheckpoint,
  guardRuntimeManualAction,
} from "../../src/controller/manual-checkpoint.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import {
  checkpointRecordSchema,
  type ManualActionCategory,
} from "../../src/persistence/records.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-manual-checkpoint-"));
  temporaryDirectories.push(root);
  return {
    store: new AtomicJsonStore(root),
    context: {
      runId: "run-1",
      changeName: "add-search",
      taskId: "9.1",
      branch: ["9.1", "9.2"],
    },
  };
}

describe("manual action classification", () => {
  test("persists every planned manual category without executing the action", async () => {
    const categories: ManualActionCategory[] = [
      "authentication",
      "elevated_permission",
      "destructive",
      "external_side_effect",
      "design_decision",
    ];

    for (const category of categories) {
      const { store, context } = await fixture();
      const checkpoint = await checkpointPlannedManualAction({
        ...context,
        store,
        manual: {
          category,
          reason: `Manual ${category} step is required`,
          instructions: ["Complete the reviewed action outside the agent channel"],
          expectedOutcome: "The prerequisite is available",
          resumeTarget: "9.1",
        },
      });

      expect(checkpoint).toMatchObject({
        category,
        status: "pending",
        resumeTarget: "9.1",
      });
      expect(checkpointRecordSchema.parse(
        await store.read(context.runId, `checkpoints/${checkpoint.id}.json`),
      )).toEqual(checkpoint);
    }
  });

  test.each([
    ["interactive", "npm", ["login"], "authentication"],
    ["prohibited", "git", ["push", "--force", "origin", "main"], "destructive"],
  ] as const)("stops %s commands before execution", async (_name, executable, args, category) => {
    const { store, context } = await fixture();
    let executed = false;
    const result = await guardRuntimeManualAction({
      ...context,
      store,
      request: {
        profile: "verification",
        executable,
        args,
        cwd: "/repo",
      },
    }, async () => {
      executed = true;
      return "executed";
    });

    expect(executed).toBeFalse();
    expect(result.status).toBe("awaiting_user");
    if (result.status !== "awaiting_user") throw new Error("expected checkpoint");
    expect(result.checkpoint.category).toBe(category);
    expect(JSON.stringify(result.checkpoint)).not.toContain(args.join(" "));
  });

  test("redacts known and conventionally formatted secrets before the atomic write", async () => {
    const { store, context } = await fixture();
    const checkpoint = await createManualCheckpoint({
      ...context,
      store,
      category: "authentication",
      reason: "Login failed with token=runtime-secret and Authorization: Bearer bearer-secret",
      instructions: ["Run tool --password hunter2, then resume with runtime-secret"],
      resumeTarget: "9.1",
      secretValues: ["runtime-secret"],
    });
    const persisted = await store.read(context.runId, `checkpoints/${checkpoint.id}.json`);
    const serialized = JSON.stringify(persisted);

    expect(serialized).not.toContain("runtime-secret");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("[REDACTED]");
  });
});