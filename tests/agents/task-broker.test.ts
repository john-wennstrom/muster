import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CollaborationTask } from "../../src/execution/collaboration-task.ts";
import { createTaskBroker } from "../../src/agents/task-broker.ts";
import { runProcess } from "../../src/shared/process.ts";
import { createInertJudgmentRuntime, type JudgmentRuntime, type JudgmentVerdict } from "../../src/judgment/ask.ts";
import { abstain, act, type CommandGateValue } from "../../src/judgment/gates.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-task-broker-"));
  temporaryDirectories.push(root);
  await mkdir(resolve(root, "src"));
  await writeFile(resolve(root, "src", "file.ts"), "before\n");
  await writeFile(resolve(root, "README.md"), "before\n");
  for (const args of [
    ["init"],
    ["config", "user.email", "muster@example.invalid"],
    ["config", "user.name", "Muster Tests"],
    ["add", "."],
    ["commit", "-m", "initial"],
  ]) {
    const result = await runProcess("git", args, { cwd: root, timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  const task: CollaborationTask = {
    id: "1.a",
    assignee: "main",
    description: "update source",
    depends_on: [],
    outputs: ["src/file.ts"],
    mode: "write",
    reads: ["src/**"],
    writes: ["src/**"],
  };
  return { root, task };
}

function request(tool: string, input: unknown) {
  return {
    correlationId: crypto.randomUUID(),
    tool,
    input,
    signal: new AbortController().signal,
  };
}

describe("task broker", () => {
  test("scope evidence retains its tool identity alongside standard tools", async () => {
    const { root, task } = await fixture();
    const submitted: string[] = [];
    const broker = await createTaskBroker({
      cwd: root, runId: "scope", childId: "planner", role: "architect",
      task: { ...task, mode: "read", writes: [] },
      persistEvidence: async (tool) => { submitted.push(tool); return { accepted: true }; },
    });
    try {
      await broker.handleRequest(request("submit_scope", { reads: ["src/**"], writes: ["src/file.ts"] }));
      expect(submitted).toEqual(["submit_scope"]);
    } finally {
      await broker.close();
    }
  });

  test("search includes untracked source, skips ignored dependencies and run logs, and supports file scopes", async () => {
    const { root, task } = await fixture();
    await writeFile(resolve(root, ".gitignore"), "node_modules/\nignored/\n");
    for (const directory of ["node_modules", "ignored", ".fusion"]) {
      await mkdir(resolve(root, directory));
      await writeFile(resolve(root, directory, "noise.txt"), "skill should not appear\n");
    }
    await writeFile(resolve(root, "src", "untracked.ts"), "skill marker\n");
    const broker = await createTaskBroker({
      cwd: root, runId: "search", childId: "architect", role: "architect",
      task: { ...task, mode: "read", reads: ["**"], writes: [] },
    });
    try {
      expect(await broker.handleRequest(request("search", { query: "skill" }))).toEqual(["src/untracked.ts:1:skill marker"]);
      expect(await broker.handleRequest(request("search", { query: "before", path: "src/file.ts" }))).toEqual(["src/file.ts:1:before"]);
      expect(await broker.handleRequest(request("search", { query: "before", path: "src" }))).toEqual(["src/file.ts:1:before"]);
      const aborted = request("search", { query: "skill" });
      aborted.signal = AbortSignal.abort();
      await expect(broker.handleRequest(aborted)).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
    } finally {
      await broker.close();
    }
  });

  test("derives repository identity, scopes writes, and holds an identity-aware lease", async () => {
    const { root, task } = await fixture();
    const lockDirectory = resolve(root, ".locks");
    const broker = await createTaskBroker({
      cwd: root,
      runId: "broker-run-1",
      childId: "child-1",
      role: "builder",
      task,
      lease: { lockDirectory },
    });

    expect(broker.writerLease).toMatchObject({
      repositoryId: broker.repositoryId,
      worktreePath: broker.worktreePath,
      runId: "broker-run-1",
      taskId: "1.a",
    });
    await broker.handleRequest(request("write_file", { path: "src/file.ts", content: "after\n" }));
    expect(await readFile(resolve(root, "src", "file.ts"), "utf8")).toBe("after\n");
    await expect(broker.handleRequest(request("write_file", {
      path: "README.md",
      content: "outside\n",
    }))).rejects.toThrow(/outside declared write scopes/);
    expect(await readFile(resolve(root, "README.md"), "utf8")).toBe("before\n");

    await expect(createTaskBroker({
      cwd: root,
      runId: "broker-run-2",
      childId: "child-2",
      role: "builder",
      task: { ...task, id: "1.b" },
      lease: { lockDirectory },
    })).rejects.toMatchObject({ code: "WRITER_LEASE_BUSY" });
    await broker.close();
  });

  test("does not issue a writer lease for a read-only task", async () => {
    const { root, task } = await fixture();
    const broker = await createTaskBroker({
      cwd: root,
      runId: "broker-run-1",
      childId: "child-1",
      role: "architect",
      task: { ...task, mode: "read", writes: [] },
    });

    expect(broker.writerLease).toBeNull();
    expect(await broker.handleRequest(request("read_file", { path: "src/file.ts" }))).toBe("before\n");
    await expect(broker.handleRequest(request("write_file", {
      path: "src/file.ts",
      content: "after\n",
    }))).rejects.toThrow(/running task|matching active writer lease/);
    await broker.close();
  });

  test("routes validator gate evidence to the parent without a writer lease", async () => {
    const { root, task } = await fixture();
    let submitted: Readonly<Record<string, unknown>> | undefined;
    const broker = await createTaskBroker({
      cwd: root,
      runId: "broker-run-1",
      childId: "validator-1",
      role: "validator",
      task: { ...task, mode: "read", writes: [] },
      persistEvidence: async (_tool, input) => {
        submitted = input;
        return { persisted: true };
      },
    });

    expect(await broker.handleRequest(request("submit_gate", {
      format: "python",
      content: "print('ok')\n",
    }))).toEqual({ persisted: true });
    expect(submitted).toEqual({ format: "python", content: "print('ok')\n" });
    expect(broker.writerLease).toBeNull();
    await broker.close();
  });
});

describe("task broker command judgment", () => {
  function judged(verdict: JudgmentVerdict<CommandGateValue>) {
    const calls: unknown[] = [];
    const runtime = {
      enabled: true,
      async askJev() { throw new Error("unused"); },
      async judge(_decision: unknown, call: unknown) {
        calls.push(call);
        return verdict;
      },
    } as unknown as JudgmentRuntime;
    return { runtime, calls };
  }

  const touch = { profile: "verification", executable: "node", args: ["-e", "require('fs').writeFileSync('src/file.ts', 'ran\\n')"] };

  test("a brokered command judged as a manual category is denied end to end", async () => {
    const { root, task } = await fixture();
    const { runtime, calls } = judged({
      kind: "enforce",
      outcome: act({ category: "external_side_effect", confidence: 0.5 }),
      recordId: "record-1",
    });
    const broker = await createTaskBroker({
      cwd: root, runId: "judged", childId: "builder", role: "builder", task,
      judgment: { runtime, changeName: "add-search", taskId: task.id },
    });
    try {
      await expect(broker.handleRequest(request("command", { ...touch, cwd: root })))
        .rejects.toMatchObject({ code: "HOST_COMMAND_PROHIBITED", details: { category: "external_side_effect", source: "judgment" } });
      expect(calls).toHaveLength(1);
      expect(await readFile(resolve(root, "src", "file.ts"), "utf8")).toBe("before\n");
    } finally {
      await broker.close();
    }
  });

  test("a command judged none runs as it does without judgment", async () => {
    const { root, task } = await fixture();
    const { runtime, calls } = judged({ kind: "enforce", outcome: abstain("none"), recordId: null });
    const broker = await createTaskBroker({
      cwd: root, runId: "none", childId: "builder", role: "builder", task,
      judgment: { runtime, changeName: "add-search", taskId: task.id },
    });
    try {
      await broker.handleRequest(request("command", { ...touch, cwd: root }));
      expect(calls).toHaveLength(1);
      expect(await readFile(resolve(root, "src", "file.ts"), "utf8")).toBe("ran\n");
    } finally {
      await broker.close();
    }
  });

  test("an adapter without a runtime behaves as before", async () => {
    const { root, task } = await fixture();
    const broker = await createTaskBroker({
      cwd: root, runId: "plain", childId: "builder", role: "builder", task,
    });
    try {
      await broker.handleRequest(request("command", { ...touch, cwd: root }));
      expect(await readFile(resolve(root, "src", "file.ts"), "utf8")).toBe("ran\n");
    } finally {
      await broker.close();
    }
  });

  test("disabled judgment sends nothing and the command runs", async () => {
    const { root, task } = await fixture();
    const inert = createInertJudgmentRuntime();
    let asked = 0;
    const spied = { ...inert, async judge(...args: Parameters<JudgmentRuntime["judge"]>) { asked += 1; return inert.judge(...args); } } as JudgmentRuntime;
    const broker = await createTaskBroker({
      cwd: root, runId: "disabled", childId: "builder", role: "builder", task,
      judgment: { runtime: spied, changeName: "add-search", taskId: task.id },
    });
    try {
      await broker.handleRequest(request("command", { ...touch, cwd: root }));
      expect(asked).toBe(0);
      expect(await readFile(resolve(root, "src", "file.ts"), "utf8")).toBe("ran\n");
    } finally {
      await broker.close();
    }
  });

  test("a rule-denied brokered command is never judged", async () => {
    const { root, task } = await fixture();
    const { runtime, calls } = judged({ kind: "enforce", outcome: abstain("none"), recordId: null });
    const broker = await createTaskBroker({
      cwd: root, runId: "rules", childId: "builder", role: "builder", task,
      judgment: { runtime, changeName: "add-search", taskId: task.id },
    });
    try {
      await expect(broker.handleRequest(request("command", {
        profile: "verification", executable: "npm", args: ["publish"], cwd: root,
      }))).rejects.toMatchObject({ code: "HOST_COMMAND_PROHIBITED", details: { category: "external_side_effect" } });
      expect(calls).toHaveLength(0);
    } finally {
      await broker.close();
    }
  });
});
