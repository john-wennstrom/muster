import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import { newRun } from "../../src/agents/run-record.ts";
import { runAgent } from "../../src/agents/spawn.ts";
import { runProcess } from "../../src/shared/process.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("runAgent", () => {
  test("a read agent runs with read tools and no writer lease", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-spawn-read-"));
    directories.push(root);
    expect((await runProcess("git", ["init"], { cwd: root, timeoutMs: 10_000 })).exitCode).toBe(0);
    const entry = resolve(root, "child.mjs");
    await writeFile(entry, `console.log(JSON.stringify({type: "message_end", message: {role: "assistant", stopReason: "stop", content: [{type: "text", text: JSON.stringify({args: process.argv.slice(2), prompt: process.argv.at(-1), write: process.env.MUSTER_BROKER_WRITE_ENABLED})}]}}));`);
    const stack = synthesizeLegacyStack({ architectModel: "fixture/architect", builderModel: "fixture/builder", architectThinking: "high", builderThinking: "high" });
    const run = newRun("ARCHITECT", stack.architect.model, stack.architect);
    const started: string[] = [];
    const originalEntry = process.argv[1];
    try {
      process.argv[1] = entry;
      await runAgent({
        access: "read",
        run,
        modelStack: stack,
        onAgentStart: (started_) => started.push(started_.role),
        prompt: "explore",
        role: "architect",
        runId: "run-1",
        childId: "child-1",
        taskId: "change.explore",
        description: "explore",
        assignee: "architect",
        thinking: "low",
        sessionDir: resolve(root, "sessions"),
        cwd: root,
        timeoutMs: 5_000,
      });
    } finally {
      process.argv[1] = originalEntry!;
    }
    expect(started).toEqual(["ARCHITECT"]);
    expect(run.status).toBe("done");
    const result = JSON.parse(run.text) as { args: string[]; prompt: string; write: string };
    expect(result.args[result.args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect(result.write).toBe("0");
    expect(result.prompt).toContain("Do not modify repository files.");
    expect(result.args[result.args.indexOf("--session-dir") + 1]).toContain(resolve(root, "sessions", "run-1", "change.explore", "architect"));
  });

  test("a spawn failure settles the run as failed and rethrows", async () => {
    const run = newRun("ARCHITECT", "fixture/architect");
    await expect(runAgent({
      access: "read",
      run,
      prompt: "explore",
      role: "architect",
      runId: "run-1",
      childId: "child-1",
      taskId: "change.explore",
      description: "explore",
      assignee: "architect",
      thinking: "low",
      sessionDir: "/tmp/never-used",
      cwd: resolve(tmpdir(), "muster-spawn-missing-directory"),
      timeoutMs: 1_000,
    })).rejects.toBeDefined();
    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(1);
  });

  test("exactly one source module launches the Pi executable", async () => {
    const root = resolve(import.meta.dir, "../../src");
    const launchers: string[] = [];
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      if (source.includes("process.execPath") || source.includes('"--no-extensions"')) {
        launchers.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
    expect(launchers).toEqual(["agents/spawn.ts"]);
  });
});
