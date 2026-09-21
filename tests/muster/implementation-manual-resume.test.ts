import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runProductionImplementation } from "../../src/change/phases/implementation.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecApplyInstructions, OpenSpecStatus } from "../../src/openspec/protocol.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { createTddEvidence } from "../../src/policies/tdd.ts";
import { runProcess } from "../../src/shared/process.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

function tasksMd(): string {
  const builder = (id: string, dependsOn: string[]) => [
    `- [ ] ${id} Build part ${id}`,
    "",
    "  ```yaml harness-task",
    `  id: "${id}"`,
    `  dependsOn: ${JSON.stringify(dependsOn)}`,
    "  role: builder",
    '  reads: ["src/**"]',
    '  writes: ["src/**"]',
    '  requirements: ["search: Search works"]',
    '  scenarios: ["Successful search"]',
    '  verify: ["bun test tests/search.test.ts"]',
    "  manual: null",
    "  ```",
    "",
  ].join("\n");
  const manual = (id: string, dependsOn: string[]) => [
    `- [ ] ${id} Owner confirms the label wording`,
    "",
    "  ```yaml harness-task",
    `  id: "${id}"`,
    `  dependsOn: ${JSON.stringify(dependsOn)}`,
    "  role: manual",
    "  reads: []",
    "  writes: []",
    '  requirements: ["search: Search works"]',
    '  scenarios: ["Successful search"]',
    '  verify: ["bun test tests/search.test.ts"]',
    "  manual:",
    "    category: design_decision",
    "    reason: The owner must confirm the wording",
    '    instructions: ["Read the labels and confirm them"]',
    "    expectedOutcome: The owner confirmed the wording",
    '    resumeTarget: "1.3"',
    "  ```",
    "",
  ].join("\n");
  return `## 1. Search\n\n${builder("1.1", [])}\n${manual("1.2", ["1.1"])}\n${builder("1.3", ["1.2"])}`;
}

const evidenceFor = (taskId: string) => createTddEvidence({
  runId: "run-add-search",
  taskId,
  requirements: ["search: Search works"],
  scenarios: ["Successful search"],
  red: { command: "bun test", exitCode: 1, recordedAt: "2026-09-17T10:00:00.000Z" },
  green: { command: "bun test", exitCode: 0, recordedAt: "2026-09-17T10:01:00.000Z" },
  refactor: [{ command: "bun test", exitCode: 0, recordedAt: "2026-09-17T10:02:00.000Z" }],
  createdAt: "2026-09-17T10:02:00.000Z",
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-manual-resume-"));
  roots.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "muster@example.invalid");
  await git(root, "config", "user.name", "Muster Tests");
  const changeRoot = resolve(root, "openspec", "changes", "add-search");
  await mkdir(resolve(changeRoot, "specs", "search"), { recursive: true });
  const tasksPath = resolve(changeRoot, "tasks.md");
  await Promise.all([
    writeFile(resolve(changeRoot, "proposal.md"), "# Proposal\n"),
    writeFile(resolve(changeRoot, "design.md"), "# Design\n"),
    writeFile(resolve(changeRoot, "specs", "search", "spec.md"), "## Purpose\nSearch capability.\n"),
    writeFile(tasksPath, tasksMd()),
  ]);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");

  const status = {
    changeName: "add-search",
    schemaName: "fusion-driven",
    planningHome: { kind: "repo", root, changesDir: resolve(root, "openspec", "changes"), defaultSchema: "fusion-driven" },
    changeRoot,
    artifactPaths: { tasks: { outputPath: "tasks.md", resolvedOutputPath: tasksPath, existingOutputPaths: [tasksPath] } },
    isPlanningComplete: true,
    isComplete: true,
    applyRequires: ["review"],
    nextSteps: [],
    actionContext: { mode: "repo-local", sourceOfTruth: "repo", planningArtifacts: [], linkedContext: [], allowedEditRoots: [root], requiresAffectedAreaSelection: false, constraints: [] },
    artifacts: [{ id: "tasks", outputPath: "tasks.md", status: "done", requires: [] }],
    root: { path: root, source: "nearest" },
  } satisfies OpenSpecStatus;
  const apply: OpenSpecApplyInstructions = {
    changeName: "add-search",
    changeDir: changeRoot,
    schemaName: "fusion-driven",
    contextFiles: { tasks: [tasksPath] },
    progress: { total: 2, complete: 0, remaining: 2 },
    tasks: [],
    state: "ready",
    instruction: "Implement",
    root: { path: root, source: "nearest" },
  };
  const adapter = { status: async () => status, applyInstructions: async () => apply } as unknown as OpenSpecAdapter;
  const identity = await new GitAdapter(root).identity();
  const head = await new GitAdapter(root).head();
  return { root, store: createChangeUsageStore(root), adapter, identity, head };
}


type Subject = Awaited<ReturnType<typeof fixture>>;

async function run(subject: Subject, built: string[], checkpointId?: string) {
  return runProductionImplementation({
    cwd: subject.root,
    changeName: "add-search",
    reviewFreshness: "current",
    argv: [],
    openSpec: subject.adapter,
    checkpointId,
    confirmedBy: "owner",
    now: () => new Date("2026-09-17T10:00:00.000Z"),
    ports: {
      selectWorktree: async () => ({
        repositoryId: subject.identity.id,
        commonDirectory: subject.identity.commonDirectory,
        path: subject.identity.root,
        branch: "muster/add-search",
        head: subject.head.commit,
        reused: true,
      }),
      runBuilder: async (task) => {
        built.push(task.id);
        return { claim: "completed", implementationPersisted: true, tddEvidence: evidenceFor(task.id) };
      },
      runVerification: async () => ({ passed: true, evidence: ["bun test tests/search.test.ts: pass"] }),
      runReview: async () => ({ approved: true, findings: [] }),
    },
  });
}

const checkpointsOf = async (subject: Subject) => {
  const directory = resolve(subject.root, ".fusion", "runs", "run-add-search", "checkpoints");
  const names = await readdir(directory).catch(() => [] as string[]);
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8"))));
};

describe("resuming a planned manual task", () => {
  test("pauses at the manual task and blocks the branch behind it", async () => {
    const subject = await fixture();
    const built: string[] = [];
    const outcome = await run(subject, built);
    expect(built).toEqual(["1.1"]);
    expect(outcome.status).toBe("blocked");
    const checkpoints = await checkpointsOf(subject);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ taskId: "1.2", status: "pending" });
  });

  test("resume completes the manual task and runs the rest instead of pausing again", async () => {
    const subject = await fixture();
    await run(subject, []);
    const [pending] = await checkpointsOf(subject);

    const built: string[] = [];
    const outcome = await run(subject, built, pending.id);

    expect(outcome.status).toBe("success");
    expect(built).toEqual(["1.3"]);
    const checkpoints = await checkpointsOf(subject);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ id: pending.id, status: "confirmed", confirmedBy: "owner" });
    const tasks = await readFile(resolve(subject.root, "openspec", "changes", "add-search", "tasks.md"), "utf8");
    expect(tasks).toMatch(/- \[x\] 1\.1 /);
    expect(tasks).toMatch(/- \[x\] 1\.2 /);
    expect(tasks).toMatch(/- \[x\] 1\.3 /);
  });

  test("records the confirmation as the manual task's completion evidence", async () => {
    const subject = await fixture();
    await run(subject, []);
    const [pending] = await checkpointsOf(subject);
    await run(subject, [], pending.id);

    const result = JSON.parse(await readFile(
      resolve(subject.root, ".fusion", "runs", "run-add-search", "task-results", "1.2.json"),
      "utf8",
    ));
    expect(result).toMatchObject({ taskId: "1.2", outcome: "completed" });
    expect(result.verificationEvidence.join(" ")).toContain(pending.id);
  });
});
