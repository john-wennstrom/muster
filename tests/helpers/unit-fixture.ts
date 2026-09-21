import { afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeLane, type Lane } from "../../src/controller/lane.ts";
import type { RecoveryEnd } from "../../src/execution/failed-attempt.ts";
import type { JudgmentRuntime } from "../../src/judgment/ask.ts";
import { compileTaskDag } from "../../src/execution/delegation-dag.ts";
import { loadValidatedTaskDocument } from "../../src/execution/load-tasks.ts";
import { RunManifestKeeper } from "../../src/execution/run-manifest.ts";
import type { ChangeTaskExecutionContext } from "../../src/execution/scheduler.ts";
import { createUnitRunner, type UnitSteps } from "../../src/execution/unit-runner.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { openChangeRun } from "../../src/persistence/run-store.ts";
import { createTddEvidence } from "../../src/policies/tdd.ts";
import { runProcess } from "../../src/shared/process.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const at = new Date("2026-09-21T10:00:00.000Z");

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

const taskBlock = (id: string, manual: boolean) => [
  `- [ ] ${id} ${manual ? "Owner confirms the wording" : "Build search"}`,
  "",
  "  ```yaml harness-task",
  `  id: "${id}"`,
  "  dependsOn: []",
  `  role: ${manual ? "manual" : "builder"}`,
  `  reads: ${manual ? "[]" : '["src/**"]'}`,
  `  writes: ${manual ? "[]" : '["src/**"]'}`,
  '  requirements: ["search: Search works"]',
  '  scenarios: ["Successful search"]',
  '  verify: ["bun test tests/search.test.ts"]',
  ...(manual
    ? [
      "  manual:",
      "    category: design_decision",
      "    reason: The owner must confirm the wording",
      '    instructions: ["Read the labels and confirm them"]',
      "    expectedOutcome: The owner confirmed the wording",
      '    resumeTarget: "1.1"',
    ]
    : ["  manual: null"]),
  "  ```",
  "",
].join("\n");

const evidence = () => createTddEvidence({
  runId: "run-add-search",
  taskId: "1.1",
  requirements: ["search: Search works"],
  scenarios: ["Successful search"],
  red: { command: "bun test", exitCode: 1, recordedAt: "2026-09-21T10:00:00.000Z" },
  green: { command: "bun test", exitCode: 0, recordedAt: "2026-09-21T10:01:00.000Z" },
  refactor: [{ command: "bun test", exitCode: 0, recordedAt: "2026-09-21T10:02:00.000Z" }],
  createdAt: "2026-09-21T10:02:00.000Z",
});

export interface UnitFixtureOptions {
  judgment?: JudgmentRuntime;
  lane?: Lane;
  maxAttempts?: number;
}

export async function setup(manual: boolean, steps: Partial<UnitSteps>, options: UnitFixtureOptions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-unit-runner-"));
  roots.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "muster@example.invalid");
  await git(root, "config", "user.name", "Muster Tests");
  const tasksPath = resolve(root, "openspec", "changes", "add-search", "tasks.md");
  await mkdir(resolve(tasksPath, ".."), { recursive: true });
  await writeFile(tasksPath, `## 1. Search\n\n${taskBlock("1.1", manual)}`);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");

  const { contents, document } = await loadValidatedTaskDocument(tasksPath);
  const dag = compileTaskDag(document.tasks.map((task) => ({ id: task.id, dependsOn: task.dependsOn, checked: task.checked })), "a".repeat(64), at.toISOString());
  const changeRun = openChangeRun(root, "add-search");
  const store = new AtomicJsonStore(resolve(root, ".fusion", "runs"));
  if (options.lane) await writeLane(store, "add-search", { lane: options.lane, source: "user", reasons: ["fixture"] });
  const identity = await new GitAdapter(root).identity();
  const head = await new GitAdapter(root).head();
  const keeper = await RunManifestKeeper.open({
    store,
    runId: "run-add-search",
    changeName: "add-search",
    worktree: { repositoryId: identity.id, commonDirectory: identity.commonDirectory, path: root, branch: "b", head: head.commit, reused: true },
    artifactDigest: "digest",
    document,
    creation: { head: head.commit, gitStatus: [], diff: "", modelAssignments: { reviewer: "openai/reviewer" } },
    now: () => at,
  });
  const calls: string[] = [];
  const recoveryEnds: RecoveryEnd[] = [];
  const allSteps: UnitSteps = {
    runBuilder: async (_task, _context, _signal, attempt) => {
      calls.push(`builder:${attempt}`);
      return { claim: "completed", implementationPersisted: true, tddEvidence: evidence() };
    },
    runVerification: async () => {
      calls.push("verification");
      return { passed: true, evidence: ["bun test tests/search.test.ts: pass"] };
    },
    runReview: async () => {
      calls.push("review");
      return { approved: true, findings: [] };
    },
    ...steps,
  };
  const pendingCheckpoints: Parameters<typeof createUnitRunner>[0]["pendingCheckpoints"] = [];
  const execute = createUnitRunner({
    runId: "run-add-search",
    changeName: "add-search",
    planningCwd: root,
    store,
    changeRun,
    dag,
    document,
    tasksPath,
    state: { contents },
    keeper,
    pendingCheckpoints,
    steps: allSteps,
    fallbackReviewerModel: "openai/fallback",
    now: () => at,
    judgment: options.judgment,
    maxAttempts: options.maxAttempts ?? 2,
    recoveryEnds,
  });
  const context = { worktree: { path: root } } as unknown as ChangeTaskExecutionContext;
  const read = async (path: string) => JSON.parse(await readFile(resolve(root, ".fusion", "runs", "run-add-search", path), "utf8"));
  return { root, store, tasksPath, keeper, calls, recoveryEnds, pendingCheckpoints, run: (attempt = 1) => execute({ id: "1.1" }, attempt, context), read };
}

