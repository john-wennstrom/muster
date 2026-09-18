import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { computeSourceDigest } from "../../src/execution/change-digests.ts";
import { GitAdapter } from "../../src/execution/git.ts";
import { runProductionImplementation } from "../../src/muster/implementation-runtime.ts";
import { runProductionFinish, runProductionVerification } from "../../src/muster/verification-runtime.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecApplyInstructions, OpenSpecStatus, OpenSpecValidation } from "../../src/openspec/protocol.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { discoverReviewedArtifacts, hashReviewedArtifacts } from "../../src/review/artifact-digest.ts";
import { createReviewArtifact, writeReviewArtifact } from "../../src/review/review-artifact.ts";
import { runProcess } from "../../src/shared/process.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function fixture(taskChecked = true) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-implementation-runtime-"));
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
    writeFile(tasksPath, [
      "## 1. Search",
      "",
      `- [${taskChecked ? "x" : " "}] 1.1 Add search`,
      "",
      "  ```yaml harness-task",
      "  id: \"1.1\"",
      "  dependsOn: []",
      "  role: builder",
      "  reads: [\"src/**\"]",
      "  writes: [\"src/**\"]",
      "  requirements: [\"search: Search works\"]",
      "  scenarios: [\"Successful search\"]",
      "  verify: [\"bun test tests/search.test.ts\"]",
      "  manual: null",
      "  ```",
      "",
    ].join("\n")),
  ]);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const status: OpenSpecStatus = {
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
  };
  const apply: OpenSpecApplyInstructions = {
    changeName: "add-search",
    changeDir: changeRoot,
    schemaName: "fusion-driven",
    contextFiles: { tasks: [tasksPath] },
    progress: { total: 1, complete: taskChecked ? 1 : 0, remaining: taskChecked ? 0 : 1 },
    tasks: [{ id: "1", description: "1.1 Add search", done: taskChecked }],
    state: taskChecked ? "all_done" : "ready",
    instruction: "Complete",
    root: { path: root, source: "nearest" },
  };
  const validation: OpenSpecValidation = {
    items: [{ id: "add-search", type: "change", valid: true, issues: [] }],
    summary: { totals: { items: 1, passed: 1, failed: 0 }, byType: { change: { items: 1, passed: 1, failed: 0 } } },
    version: "fixture",
    root: { path: root, source: "nearest" },
  };
  const archiveCalls: string[] = [];
  const adapter = {
    status: async () => status,
    applyInstructions: async () => apply,
    validate: async () => validation,
    archive: async (changeName: string) => {
      archiveCalls.push(changeName);
      return {
        archive: {
          change: changeName,
          archivedAs: "2026-09-17-add-search",
          path: resolve(root, "openspec", "changes", "archive", "2026-09-17-add-search"),
          specsUpdated: ["search"],
        },
        root: { path: root, source: "nearest" },
      };
    },
  } as unknown as OpenSpecAdapter;
  const identity = await new GitAdapter(root).identity();
  const head = await new GitAdapter(root).head();
  return { root, changeRoot, adapter, archiveCalls, identity, head };
}

async function seedPassingEvidence(subject: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const now = "2026-09-17T10:02:00.000Z";
  const artifactDigest = await hashReviewedArtifacts(
    await discoverReviewedArtifacts(subject.root, subject.changeRoot),
  );
  await writeReviewArtifact(resolve(subject.changeRoot, "review.md"), createReviewArtifact({
    schemaVersion: 1,
    round: 1,
    reviewedAt: now,
    model: "fixture-reviewer",
    artifactDigest,
    requestedVerdict: "APPROVE",
    criticalFindings: [],
    requiredChanges: [],
    recommendations: [],
  }));
  const gitAdapter = new GitAdapter(subject.root);
  const [head, diff] = await Promise.all([gitAdapter.head(), gitAdapter.diff()]);
  const sourceDigest = computeSourceDigest(head.commit, diff);
  const store = createChangeUsageStore(subject.root);
  await Promise.all([
    store.write("run-add-search", "task-results/1.1.json", {
      schemaVersion: 1,
      runId: "run-add-search",
      taskId: "1.1",
      outcome: "completed",
      sourceDigest,
      verificationEvidence: ["bun test tests/search.test.ts"],
      completedAt: now,
    }),
    store.write("run-add-search", "reviews/task-1.1.json", {
      schemaVersion: 1,
      runId: "run-add-search",
      taskId: "1.1",
      kind: "task",
      verdict: "APPROVE",
      artifactDigest: sourceDigest,
      model: "fixture-reviewer",
      findings: [],
      createdAt: now,
    }),
    store.write("run-add-search", "reports/1.1.json", {
      schemaVersion: 1,
      runId: "run-add-search",
      taskId: "1.1",
      outcome: "completed",
      summary: "Search implementation completed.",
      changedInterfaces: [],
      evidence: ["bun test tests/search.test.ts"],
      createdAt: now,
    }),
  ]);
}

describe("production implementation and verification runtime", () => {
  test("prepares a durable implementation run and reaches the implementation controller", async () => {
    const subject = await fixture();
    const outcome = await runProductionImplementation({
      cwd: subject.root,
      changeName: "add-search",
      reviewFreshness: "current",
      argv: [],
      openSpec: subject.adapter,
      ports: {
        selectWorktree: async () => ({
          repositoryId: subject.identity.id,
          commonDirectory: subject.identity.commonDirectory,
          path: subject.identity.root,
          branch: "muster/add-search",
          head: subject.head.commit,
          reused: true,
        }),
      },
      now: () => new Date("2026-09-17T10:00:00.000Z"),
    });

    expect(outcome).toMatchObject({ status: "success", action: "implement", runId: "run-add-search" });
    const manifest = JSON.parse(await readFile(resolve(subject.root, ".fusion", "runs", "run-add-search", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ changeName: "add-search", artifactDigest: expect.any(String) });
  });

  test("final validation fails closed when completed-task evidence is absent and persists verification", async () => {
    const subject = await fixture();
    await runProductionImplementation({
      cwd: subject.root,
      changeName: "add-search",
      reviewFreshness: "current",
      argv: [],
      openSpec: subject.adapter,
      ports: {
        selectWorktree: async () => ({
          repositoryId: subject.identity.id,
          commonDirectory: subject.identity.commonDirectory,
          path: subject.identity.root,
          branch: "muster/add-search",
          head: subject.head.commit,
          reused: true,
        }),
      },
    });
    const outcome = await runProductionVerification({
      cwd: subject.root,
      changeName: "add-search",
      argv: [],
      openSpec: subject.adapter,
      ports: { runCommand: async (command) => ({ command, exitCode: 0 }) },
      now: () => new Date("2026-09-17T10:05:00.000Z"),
    });

    expect(outcome.status).toBe("blocked");
    expect(outcome.summary).toContain("Task 1.1 lacks completed persisted evidence");
    expect(await readFile(resolve(subject.changeRoot, "verification.md"), "utf8")).toContain("- Result: `FAIL`");
  });

  test("collects current production evidence and persists a passing verification", async () => {
    const subject = await fixture();
    await runProductionImplementation({
      cwd: subject.root,
      changeName: "add-search",
      reviewFreshness: "current",
      argv: [],
      openSpec: subject.adapter,
      ports: {
        selectWorktree: async () => ({
          repositoryId: subject.identity.id,
          commonDirectory: subject.identity.commonDirectory,
          path: subject.identity.root,
          branch: "muster/add-search",
          head: subject.head.commit,
          reused: true,
        }),
      },
    });
    await seedPassingEvidence(subject);

    const outcome = await runProductionVerification({
      cwd: subject.root,
      changeName: "add-search",
      argv: [],
      openSpec: subject.adapter,
      ports: { runCommand: async (command) => ({ command, exitCode: 0 }) },
      now: () => new Date("2026-09-17T10:05:00.000Z"),
    });

    expect(outcome).toMatchObject({
      status: "success",
      action: "verify",
      next: "/change finish add-search",
    });
    expect(await readFile(resolve(subject.changeRoot, "verification.md"), "utf8"))
      .toContain("- Result: `PASS`");
    const validation = JSON.parse(await readFile(
      resolve(subject.root, ".fusion", "runs", "run-add-search", "validation.json"),
      "utf8",
    ));
    expect(validation).toMatchObject({ result: "PASS", commands: expect.any(Array) });

    const finish = await runProductionFinish({
      cwd: subject.root,
      changeName: "add-search",
      openSpec: subject.adapter,
    });
    expect(finish).toMatchObject({
      status: "success",
      action: "finish",
      summary: "Archived add-search as 2026-09-17-add-search.",
    });
    expect(subject.archiveCalls).toEqual(["add-search"]);
  });

  test("refuses to archive when production verification has become stale", async () => {
    const subject = await fixture();
    await runProductionImplementation({
      cwd: subject.root,
      changeName: "add-search",
      reviewFreshness: "current",
      argv: [],
      openSpec: subject.adapter,
      ports: {
        selectWorktree: async () => ({
          repositoryId: subject.identity.id,
          commonDirectory: subject.identity.commonDirectory,
          path: subject.identity.root,
          branch: "muster/add-search",
          head: subject.head.commit,
          reused: true,
        }),
      },
    });
    await seedPassingEvidence(subject);
    await runProductionVerification({
      cwd: subject.root,
      changeName: "add-search",
      argv: [],
      openSpec: subject.adapter,
      ports: { runCommand: async (command) => ({ command, exitCode: 0 }) },
    });
    await writeFile(resolve(subject.changeRoot, "proposal.md"), "# Changed after verification\n");

    await expect(runProductionFinish({
      cwd: subject.root,
      changeName: "add-search",
      openSpec: subject.adapter,
    })).rejects.toMatchObject({ code: "VERIFICATION_NOT_READY" });
    expect(subject.archiveCalls).toEqual([]);
  });

  test("persists and reports scheduler cancellation as a cancelled terminal outcome", async () => {
    const subject = await fixture(false);
    const abort = new AbortController();
    const outcome = await runProductionImplementation({
      cwd: subject.root,
      changeName: "add-search",
      reviewFreshness: "current",
      signal: abort.signal,
      argv: [],
      openSpec: subject.adapter,
      ports: {
        selectWorktree: async () => ({
          repositoryId: subject.identity.id,
          commonDirectory: subject.identity.commonDirectory,
          path: subject.identity.root,
          branch: "muster/add-search",
          head: subject.head.commit,
          reused: true,
        }),
        runBuilder: async () => {
          abort.abort();
          return { claim: "blocked", implementationPersisted: false, reason: "cancelled by test" };
        },
      },
    });

    expect(outcome).toMatchObject({ status: "cancelled", action: "implement", next: "/change status add-search" });
    const manifest = JSON.parse(await readFile(resolve(subject.root, ".fusion", "runs", "run-add-search", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ lifecycle: "CANCELLED", tasks: { "1.1": "cancelled" } });
  });
});
