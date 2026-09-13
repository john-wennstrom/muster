import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CollaborationTask } from "../../extensions/fusion-harness/modules/collaboration-graph.ts";
import {
  createLegacyTaskBroker,
  planLegacyWriteTask,
  validateLegacyScopePlan,
} from "../../src/agents/legacy-adapter.ts";
import { runProcess } from "../../src/shared/process.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-legacy-adapter-"));
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

describe("legacy task broker adapter", () => {
  test("validates a bounded read-only scope-planning result", async () => {
    const task = await planLegacyWriteTask({
      id: "1.scope",
      assignee: "main",
      description: "update the parser",
      depends_on: [],
      outputs: [],
      mode: "write",
    }, async (prompt) => {
      expect(prompt).toContain("Never use writes:[\"**\"]");
      return { reads: ["src/**", "tests/**"], writes: ["src/parser.ts", "tests/parser.test.ts"] };
    });

    expect(task.reads).toEqual(["src/**", "tests/**"]);
    expect(task.writes).toEqual(["src/parser.ts", "tests/parser.test.ts"]);
    expect(() => validateLegacyScopePlan({ reads: ["**"], writes: ["**"] })).toThrow(/repository-wide/);
    expect(() => validateLegacyScopePlan({ reads: ["src/**"], writes: ["src/**"], extra: true })).toThrow(/unknown fields/);
  });

  test("derives repository identity, scopes writes, and holds an identity-aware lease", async () => {
    const { root, task } = await fixture();
    const lockDirectory = resolve(root, ".locks");
    const broker = await createLegacyTaskBroker({
      cwd: root,
      runId: "legacy-run-1",
      childId: "child-1",
      role: "builder",
      task,
      lease: { lockDirectory },
    });

    expect(broker.writerLease).toMatchObject({
      repositoryId: broker.repositoryId,
      worktreePath: broker.worktreePath,
      runId: "legacy-run-1",
      taskId: "1.a",
    });
    await broker.handleRequest(request("write_file", { path: "src/file.ts", content: "after\n" }));
    expect(await readFile(resolve(root, "src", "file.ts"), "utf8")).toBe("after\n");
    await expect(broker.handleRequest(request("write_file", {
      path: "README.md",
      content: "outside\n",
    }))).rejects.toThrow(/outside declared write scopes/);
    expect(await readFile(resolve(root, "README.md"), "utf8")).toBe("before\n");

    await expect(createLegacyTaskBroker({
      cwd: root,
      runId: "legacy-run-2",
      childId: "child-2",
      role: "builder",
      task: { ...task, id: "1.b" },
      lease: { lockDirectory },
    })).rejects.toMatchObject({ code: "WRITER_LEASE_BUSY" });
    await broker.close();
  });

  test("does not issue a writer lease for a read-only legacy task", async () => {
    const { root, task } = await fixture();
    const broker = await createLegacyTaskBroker({
      cwd: root,
      runId: "legacy-run-1",
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
    const broker = await createLegacyTaskBroker({
      cwd: root,
      runId: "legacy-run-1",
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