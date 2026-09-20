import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { guardRuntimeManualAction } from "../../src/controller/manual-checkpoint.ts";
import { createInertJudgmentRuntime, type JudgmentRuntime, type JudgmentVerdict } from "../../src/judgment/ask.ts";
import { abstain, act, type CommandGateValue } from "../../src/judgment/gates.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { checkpointRecordSchema } from "../../src/persistence/records.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-manual-judgment-"));
  temporaryDirectories.push(root);
  return {
    root,
    store: new AtomicJsonStore(root),
    context: { runId: "run-1", changeName: "add-search", taskId: "9.1", branch: ["9.1"] },
  };
}

function double(verdict: JudgmentVerdict<CommandGateValue>) {
  const calls: Array<{ changeName: string; taskId?: string }> = [];
  const runtime = {
    enabled: true,
    async askJev() { throw new Error("unused"); },
    async judge(_decision: unknown, request: { changeName: string; taskId?: string }) {
      calls.push(request);
      return verdict;
    },
  } as unknown as JudgmentRuntime;
  return { runtime, calls };
}

const request = (executable: string, args: string[]) => ({
  profile: "verification",
  executable,
  args,
  cwd: "/repo/packages",
});

async function checkpoints(root: string): Promise<string[]> {
  try {
    return await readdir(resolve(root, "run-1", "checkpoints"));
  } catch {
    return [];
  }
}

describe("runtime manual-action guard with judgment", () => {
  test("a judged authentication category persists a pending checkpoint without executing", async () => {
    const { root, store, context } = await fixture();
    const { runtime, calls } = double({
      kind: "enforce",
      outcome: act({ category: "authentication", confidence: 0.6 }),
      recordId: "record-1",
    });
    let executed = false;
    const result = await guardRuntimeManualAction({
      ...context,
      store,
      request: request("npx", ["some-login-helper"]),
      judgment: { runtime, worktreePath: "/repo" },
    }, async () => {
      executed = true;
      return "ran";
    });

    expect(executed).toBeFalse();
    expect(result.status).toBe("awaiting_user");
    if (result.status !== "awaiting_user") throw new Error("expected checkpoint");
    expect(result.checkpoint).toMatchObject({ category: "authentication", status: "pending", resumeTarget: "9.1" });
    expect(checkpointRecordSchema.parse(
      await store.read("run-1", `checkpoints/${result.checkpoint.id}.json`),
    )).toEqual(result.checkpoint);
    expect(await checkpoints(root)).toHaveLength(1);
    expect(calls).toEqual([expect.objectContaining({ changeName: "add-search", taskId: "9.1" })]);
  });

  test("a judged category raises the same checkpoint guidance as the rule category", async () => {
    const judged = await fixture();
    const ruled = await fixture();
    const { runtime } = double({
      kind: "enforce",
      outcome: act({ category: "authentication", confidence: 0.9 }),
      recordId: null,
    });
    const fromJudgment = await guardRuntimeManualAction({
      ...judged.context,
      store: judged.store,
      request: request("npx", ["helper"]),
      judgment: { runtime, worktreePath: "/repo" },
    }, async () => "ran");
    const fromRule = await guardRuntimeManualAction({
      ...ruled.context,
      store: ruled.store,
      request: request("npm", ["login"]),
    }, async () => "ran");
    if (fromJudgment.status !== "awaiting_user" || fromRule.status !== "awaiting_user") {
      throw new Error("expected checkpoints");
    }
    expect(fromJudgment.checkpoint.reason).toBe(fromRule.checkpoint.reason);
    expect(fromJudgment.checkpoint.instructions).toEqual(fromRule.checkpoint.instructions);
  });

  test("a rule category is raised without asking judgment", async () => {
    const { store, context } = await fixture();
    const { runtime, calls } = double({ kind: "enforce", outcome: abstain("none"), recordId: null });
    const result = await guardRuntimeManualAction({
      ...context,
      store,
      request: request("npm", ["login"]),
      judgment: { runtime, worktreePath: "/repo" },
    }, async () => "ran");
    expect(result.status).toBe("awaiting_user");
    expect(calls).toHaveLength(0);
  });

  test("none, shadow, unavailable, and disabled judgment execute the command", async () => {
    const verdicts: Array<JudgmentRuntime> = [
      double({ kind: "enforce", outcome: abstain("none"), recordId: null }).runtime,
      double({ kind: "shadow", recordId: "r" }).runtime,
      double({ kind: "fallback", reason: "timeout", recordId: null }).runtime,
      createInertJudgmentRuntime(),
    ];
    for (const runtime of verdicts) {
      const { root, store, context } = await fixture();
      const result = await guardRuntimeManualAction({
        ...context,
        store,
        request: request("npm", ["run", "test"]),
        judgment: { runtime, worktreePath: "/repo" },
      }, async () => "ran");
      expect(result).toEqual({ status: "executed", value: "ran" });
      expect(await checkpoints(root)).toEqual([]);
    }
  });

  test("absent judgment, the guard behaves as before", async () => {
    const { store, context } = await fixture();
    const result = await guardRuntimeManualAction({
      ...context,
      store,
      request: request("npm", ["run", "deploy"]),
    }, async () => "ran");
    expect(result).toEqual({ status: "executed", value: "ran" });
  });
});
