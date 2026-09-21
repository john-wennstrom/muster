import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runProductionImplementation } from "../../src/change/phases/implementation.ts";
import { readLane, writeLane } from "../../src/controller/lane.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { TASK_RECOVERY_QUESTION_IDS as IDS } from "../../src/judgment/questions.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecApplyInstructions, OpenSpecStatus } from "../../src/openspec/protocol.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { createTddEvidence } from "../../src/policies/tdd.ts";
import { runProcess } from "../../src/shared/process.ts";
import { createScriptedClient } from "../helpers/scripted-judgment.ts";

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
  return `## 1. Search\n\n${builder("1.1", [])}`;
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

async function run(subject: Subject, choice: string | null, attempts: number[]) {
  const judgment = choice
    ? createJudgmentRuntime({
      env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: "enforce" },
      store: subject.store,
      client: createScriptedClient({
        "task.recovery": {
          [IDS.nextStep]: { type: "choice", choice, probabilities: { [choice]: 0.95 }, confidence: 0.95 },
          [IDS.humanNeeded]: { type: "noul", noul: 0.1 },
        },
      }),
    })
    : undefined;
  return runProductionImplementation({
    cwd: subject.root,
    changeName: "add-search",
    reviewFreshness: "current",
    argv: [],
    openSpec: subject.adapter,
    judgment,
    now: () => new Date("2026-09-21T10:00:00.000Z"),
    ports: {
      selectWorktree: async () => ({
        repositoryId: subject.identity.id,
        commonDirectory: subject.identity.commonDirectory,
        path: subject.identity.root,
        branch: "muster/add-search",
        head: subject.head.commit,
        reused: true,
      }),
      runBuilder: async (task, _context, _signal, attempt) => {
        attempts.push(attempt ?? 1);
        return { claim: "completed", implementationPersisted: true, tddEvidence: evidenceFor(task.id) };
      },
      runVerification: async () => ({
        passed: false,
        evidence: ["bun test tests/search.test.ts: exit 1"],
        failure: { command: "bun test tests/search.test.ts", exitCode: 1, output: "Expected 1, received 0" },
      }),
      runReview: async () => ({ approved: true, findings: [] }),
    },
  });
}

describe("recovery in the implementation command", () => {
  test("without judgment a failed verification blocks the command as before", async () => {
    const subject = await fixture();
    const attempts: number[] = [];
    const outcome = await run(subject, null, attempts);
    expect(attempts).toEqual([1]);
    expect(outcome).toMatchObject({ status: "blocked", next: "/change status add-search" });
  });

  test("a confident retry runs the task a second time and no third", async () => {
    const subject = await fixture();
    const attempts: number[] = [];
    const outcome = await run(subject, "retry", attempts);
    expect(attempts).toEqual([1, 2]);
    expect(outcome.status).toBe("blocked");
  });

  test("escalate moves the lane and ends the command blocked with review next", async () => {
    const subject = await fixture();
    await writeLane(subject.store, "add-search", { lane: "small", source: "user", reasons: ["fixture"] });
    const attempts: number[] = [];
    const outcome = await run(subject, "escalate", attempts);

    expect(attempts).toEqual([1]);
    expect((await readLane(subject.store, "add-search")).lane).toBe("medium");
    expect(outcome).toMatchObject({ status: "blocked", next: "/change review add-search" });
    expect(outcome.summary).toContain("medium lane");
  });

  test("stop ends the command blocked with the reason and the failure record's path", async () => {
    const subject = await fixture();
    const attempts: number[] = [];
    const outcome = await run(subject, "stop", attempts);

    expect(attempts).toEqual([1]);
    expect(outcome.status).toBe("blocked");
    expect(outcome.summary).toContain("needs a person");
    expect(outcome.summary).toContain(".fusion/runs/run-add-search/failures/1.1.json");
  });
});
