import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runProductionImplementation } from "../../src/change/phases/implementation.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import { createDecisionRecord, listDecisionRecords, writeDecisionRecord } from "../../src/judgment/audit.ts";
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
  const block = (id: string, dependsOn: string[]) => [
    `- [ ] ${id} Add search part ${id}`,
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
  return `## 1. Search\n\n${block("1.1", [])}\n${block("1.2", ["1.1"])}`;
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
  const root = await mkdtemp(resolve(tmpdir(), "muster-implementation-task-routing-"));
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

/** What the builder step writes when it asks about a task: the record of one routing decision. */
async function routingRecord(
  subject: Subject,
  taskId: string,
  how: { mode: "shadow" | "enforce"; routed: boolean; now?: () => Date },
): Promise<string> {
  const record = createDecisionRecord("add-search", {
    decision: "routing.task_model",
    decisionVersion: 1,
    phase: "implementation",
    taskId,
    mode: how.mode,
    status: "answered",
    unavailableReason: null,
    requestedModel: "jev-1.13.0",
    reportedModel: "jev-1.13.0",
    answers: {},
    gate: how.routed
      ? { act: true, value: { lane: "economy", mechanical: 0.9, risks: {}, reach: 0.4, reachConfidence: 0.9 } }
      : { act: false, reason: "changes_security_boundary probability 0.5 is not below 0.3" },
    wouldHaveActed: how.routed,
    acted: how.mode === "enforce" && how.routed,
    spend: null,
    stateDigest: "sha256:0",
  }, how.now);
  await writeDecisionRecord(subject.store, "add-search", record);
  return record.recordId;
}

interface BuilderCall { taskId: string; attempt: number | undefined }

async function implement(
  subject: Subject,
  builder: (call: { taskId: string; attempt: number }) => Promise<void> = async () => undefined,
): Promise<BuilderCall[]> {
  const calls: BuilderCall[] = [];
  await runProductionImplementation({
    cwd: subject.root,
    changeName: "add-search",
    reviewFreshness: "current",
    argv: [],
    openSpec: subject.adapter,
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
      runBuilder: async (task, _context, _signal, attempt) => {
        calls.push({ taskId: task.id, attempt });
        await builder({ taskId: task.id, attempt: attempt! });
        return { claim: "completed", implementationPersisted: true, tddEvidence: evidenceFor(task.id) };
      },
      runVerification: async () => ({ passed: true, evidence: ["bun test tests/search.test.ts: pass"] }),
      runReview: async () => ({ approved: true, findings: [] }),
    },
  });
  return calls;
}

const routingRecords = async (subject: Subject) =>
  (await listDecisionRecords(subject.store, "add-search")).filter((record) => record.decision === "routing.task_model");
const recordOf = async (subject: Subject, taskId: string) =>
  (await routingRecords(subject)).filter((record) => record.taskId === taskId);

describe("task outcomes reconciled against their routing lane", () => {
  test("the attempt number reaches the builder step", async () => {
    const subject = await fixture();
    const calls = await implement(subject, async ({ taskId, attempt }) => {
      if (taskId === "1.2" && attempt === 1) throw new Error("builder crashed");
    });
    expect(calls).toEqual([
      { taskId: "1.1", attempt: 1 },
      { taskId: "1.2", attempt: 1 },
      { taskId: "1.2", attempt: 2 },
    ]);
  });

  test("the outcome is recorded against the lane for a routed and a shadow-decided task", async () => {
    const subject = await fixture();
    await implement(subject, async ({ taskId }) => {
      // Task 1.1 was routed in enforce mode; task 1.2 would have been, in shadow mode.
      if (taskId === "1.1") await routingRecord(subject, taskId, { mode: "enforce", routed: true });
      else await routingRecord(subject, taskId, { mode: "shadow", routed: true });
    });
    const [routed] = await recordOf(subject, "1.1");
    const [shadowed] = await recordOf(subject, "1.2");
    expect(routed!.observed).toEqual({ lane: "economy", outcome: "completed" });
    expect(shadowed!.observed).toEqual({ lane: "primary", outcome: "completed" });
  });

  test("a task the gate abstained on, or judgment was unavailable for, lands on the primary lane", async () => {
    const subject = await fixture();
    await implement(subject, async ({ taskId }) => {
      await routingRecord(subject, taskId, { mode: "enforce", routed: false });
    });
    for (const taskId of ["1.1", "1.2"]) {
      expect((await recordOf(subject, taskId))[0]!.observed).toEqual({ lane: "primary", outcome: "completed" });
    }
  });

  test("a second attempt does not overwrite the first attempt's outcome", async () => {
    const subject = await fixture();
    const calls = await implement(subject, async ({ taskId, attempt }) => {
      if (taskId !== "1.2") return;
      if (attempt === 1) {
        await routingRecord(subject, taskId, { mode: "enforce", routed: true });
        throw new Error("economy lane crashed");
      }
    });
    expect(calls.filter((call) => call.taskId === "1.2").map((call) => call.attempt)).toEqual([1, 2]);
    const records = await recordOf(subject, "1.2");
    expect(records).toHaveLength(1);
    expect(records[0]!.observed).toEqual({ lane: "economy", outcome: "failed" });
  });

  test("a missing record is harmless", async () => {
    const subject = await fixture();
    const calls = await implement(subject);
    expect(calls).toHaveLength(2);
    expect(await routingRecords(subject)).toEqual([]);
  });

  test("a record from an earlier run is left alone", async () => {
    const subject = await fixture();
    const earlier = await routingRecord(subject, "1.1", { mode: "enforce", routed: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
    await implement(subject);
    const record = (await routingRecords(subject)).find((candidate) => candidate.recordId === earlier)!;
    expect(record.observed).toEqual({});
  });

  test("only routing records are reconciled", async () => {
    const subject = await fixture();
    const other = createDecisionRecord("add-search", {
      decision: "review.task_focus",
      decisionVersion: 1,
      phase: "implementation",
      taskId: "1.1",
      mode: "shadow",
      status: "answered",
      unavailableReason: null,
      requestedModel: "jev-1.13.0",
      reportedModel: "jev-1.13.0",
      answers: {},
      gate: { act: false, reason: "n/a" },
      wouldHaveActed: false,
      acted: false,
      spend: null,
      stateDigest: "sha256:0",
    });
    await implement(subject, async ({ taskId }) => {
      if (taskId === "1.1") await writeDecisionRecord(subject.store, "add-search", other);
    });
    const records = await listDecisionRecords(subject.store, "add-search");
    expect(records.find((record) => record.recordId === other.recordId)!.observed).toEqual({});
  });
});
