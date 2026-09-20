import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runProductionImplementation } from "../../src/change/phases/implementation.ts";
import {
  bindTaskQualityRecord,
  buildTaskQualityInput,
  reconcileTaskQualityOutcome,
} from "../../src/controller/task-quality.ts";
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

function tasksMd(options: { ticked?: string[]; writes?: Record<string, string> } = {}): string {
  const block = (id: string, dependsOn: string[]) => [
    `- [${options.ticked?.includes(id) ? "x" : " "}] ${id} Add search part ${id}`,
    "",
    "  ```yaml harness-task",
    `  id: "${id}"`,
    `  dependsOn: ${JSON.stringify(dependsOn)}`,
    "  role: builder",
    '  reads: ["src/**"]',
    `  writes: ["${options.writes?.[id] ?? "src/**"}"]`,
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

async function fixture(options: { ticked?: string[]; assessed?: "current" | "none"; flagged?: number[] } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-implementation-task-quality-"));
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
    writeFile(tasksPath, tasksMd({ ticked: options.ticked })),
  ]);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");

  const store = createChangeUsageStore(root);
  let recordId: string | null = null;
  if ((options.assessed ?? "current") === "current") {
    // Assessed at plan time, before anything was ticked.
    const assessed = buildTaskQualityInput([{ path: "tasks.md", content: tasksMd() }]);
    if (!assessed.ok) throw new Error(assessed.reason);
    const findings = (options.flagged ?? [2]).map((index) => ({ kind: "scope", index, probability: 0.9 }));
    const created = createDecisionRecord("add-search", {
      decision: "planning.task_quality",
      decisionVersion: 1,
      phase: "planning",
      mode: "shadow",
      status: "answered",
      unavailableReason: null,
      requestedModel: "jev-1.13.0",
      reportedModel: "jev-1.13.0",
      answers: {},
      gate: findings.length > 0 ? { act: true, value: { findings } } : { act: false, reason: "no check crossed its threshold" },
      wouldHaveActed: findings.length > 0,
      acted: false,
      spend: null,
      stateDigest: "sha256:0",
    });
    await writeDecisionRecord(store, "add-search", created);
    await bindTaskQualityRecord(store, "add-search", created.recordId, assessed);
    recordId = created.recordId;
  }

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
  return { root, store, adapter, identity, head, recordId };
}

type Subject = Awaited<ReturnType<typeof fixture>>;

async function implement(subject: Subject, builders: Record<string, (attempt: number) => Promise<"completed" | "blocked">>) {
  const attempts: Record<string, number> = {};
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
      runBuilder: async (task) => {
        attempts[task.id] = (attempts[task.id] ?? 0) + 1;
        const claim = await (builders[task.id] ?? (async () => "completed" as const))(attempts[task.id]!);
        return claim === "completed"
          ? { claim, implementationPersisted: true, tddEvidence: evidenceFor(task.id) }
          : { claim, implementationPersisted: false, reason: "blocked by test" };
      },
      runVerification: async () => ({ passed: true, evidence: ["bun test tests/search.test.ts: pass"] }),
      runReview: async () => ({ approved: true, findings: [] }),
    },
  });
  return attempts;
}

const observed = async (subject: Subject) => {
  const records = await listDecisionRecords(subject.store, "add-search");
  return records.find((record) => record.recordId === subject.recordId)!.observed;
};

describe("task outcomes reconciled against plan-time findings", () => {
  test("each task's outcome is recorded with whether it was flagged", async () => {
    const subject = await fixture();
    await implement(subject, { "1.2": async () => "blocked" });
    expect(await observed(subject)).toMatchObject({
      "outcome:1.1": { status: "completed", flagged: [] },
      "outcome:1.2": { status: "blocked", flagged: ["scope"] },
    });
  });

  test("ticking checkboxes does not detach the record", async () => {
    const subject = await fixture({ ticked: ["1.1"] });
    await implement(subject, {});
    const seen = await observed(subject);
    expect(seen["outcome:1.2"]).toEqual({ status: "completed", flagged: ["scope"] });
    expect(seen["outcome:1.1"]).toBeUndefined();
  });

  test("a task that completes on a later attempt keeps its failed first attempt", async () => {
    const subject = await fixture();
    const attempts = await implement(subject, {
      "1.2": async (attempt) => {
        if (attempt === 1) throw new Error("builder crashed");
        return "completed";
      },
    });
    expect(attempts["1.2"]).toBe(2);
    expect((await observed(subject))["outcome:1.2"]).toEqual({ status: "failed", flagged: ["scope"] });
  });

  test("a missing record is harmless", async () => {
    const subject = await fixture({ assessed: "none" });
    await implement(subject, {});
    expect(await listDecisionRecords(subject.store, "add-search")).toEqual([]);
  });
});

describe("reconcileTaskQualityOutcome", () => {
  const tasks = [
    { id: "1.1", description: "a", dependsOn: [], reads: [], writes: ["a"], verify: ["v"] },
    { id: "1.2", description: "b", dependsOn: ["1.1"], reads: [], writes: ["b"], verify: ["v"] },
  ];

  test("the first outcome is never overwritten", async () => {
    const subject = await fixture({ flagged: [2] });
    const assessed = buildTaskQualityInput([{ path: "tasks.md", content: tasksMd() }]);
    if (!assessed.ok) throw new Error(assessed.reason);
    const input = { store: subject.store, changeName: "add-search", tasks: assessed.input.tasks, taskId: "1.2" };
    await reconcileTaskQualityOutcome({ ...input, status: "blocked" });
    await reconcileTaskQualityOutcome({ ...input, status: "completed" });
    expect((await observed(subject))["outcome:1.2"]).toEqual({ status: "blocked", flagged: ["scope"] });
  });

  test("concurrent tasks each land their outcome", async () => {
    const subject = await fixture({ flagged: [1, 2] });
    const assessed = buildTaskQualityInput([{ path: "tasks.md", content: tasksMd() }]);
    if (!assessed.ok) throw new Error(assessed.reason);
    const input = { store: subject.store, changeName: "add-search", tasks: assessed.input.tasks };
    await Promise.all([
      reconcileTaskQualityOutcome({ ...input, taskId: "1.1", status: "completed" }),
      reconcileTaskQualityOutcome({ ...input, taskId: "1.2", status: "blocked" }),
    ]);
    expect(await observed(subject)).toMatchObject({
      "outcome:1.1": { status: "completed", flagged: ["scope"] },
      "outcome:1.2": { status: "blocked", flagged: ["scope"] },
    });
  });

  test("changed definitions, an unknown task, and an unassessed change record nothing", async () => {
    const subject = await fixture();
    const before = await observed(subject);
    const base = { store: subject.store, changeName: "add-search", status: "completed" };
    await reconcileTaskQualityOutcome({ ...base, tasks, taskId: "1.1" });
    const assessed = buildTaskQualityInput([{ path: "tasks.md", content: tasksMd() }]);
    if (!assessed.ok) throw new Error(assessed.reason);
    await reconcileTaskQualityOutcome({ ...base, tasks: assessed.input.tasks, taskId: "9.9" });
    expect(await observed(subject)).toEqual(before);
    await reconcileTaskQualityOutcome({ ...base, changeName: "other-change", tasks, taskId: "1.1" });
  });
});
