import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import { runProductionReview } from "../../src/change/phases/review.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecStatus } from "../../src/openspec/protocol.ts";
import { bindTaskQualityRecord, buildTaskQualityInput } from "../../src/controller/task-quality.ts";
import { createInertJudgmentRuntime, createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { createDecisionRecord, writeDecisionRecord } from "../../src/judgment/audit.ts";
import { createDeadClient } from "../../src/judgment/replay.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { createReviewArtifact, parseReviewArtifact } from "../../src/review/review-artifact.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("production review runtime", () => {
  test("dispatches the production review controller with a fresh different-model reviewer", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-review-runtime-"));
    roots.push(root);
    const changeRoot = resolve(root, "openspec", "changes", "add-search");
    await mkdir(resolve(changeRoot, "specs", "search"), { recursive: true });
    await Promise.all([
      writeFile(resolve(changeRoot, "proposal.md"), "# Proposal\n"),
      writeFile(resolve(changeRoot, "design.md"), "# Design\n"),
      writeFile(resolve(changeRoot, "tasks.md"), "# Tasks\n"),
      writeFile(resolve(changeRoot, "specs", "search", "spec.md"), "# Search\n"),
    ]);
    const status = {
      changeName: "add-search",
      schemaName: "spec-driven",
      planningHome: { kind: "repo", root, changesDir: resolve(root, "openspec", "changes"), defaultSchema: "spec-driven" },
      changeRoot,
      artifactPaths: {},
      isPlanningComplete: true,
      isComplete: true,
      applyRequires: ["tasks"],
      nextSteps: [],
      actionContext: { mode: "repo-local", sourceOfTruth: "repo", planningArtifacts: [], linkedContext: [], allowedEditRoots: [root], requiresAffectedAreaSelection: false, constraints: [] },
      artifacts: [],
      root: { path: root, source: "nearest" },
    } satisfies OpenSpecStatus;
    const stack = synthesizeLegacyStack({
      architectModel: "openai/architect",
      builderModel: "openai/reviewer",
      architectThinking: "high",
      builderThinking: "high",
    });
    const sessionIds: string[] = [];
    const outcome = await runProductionReview({
      cwd: root,
      changeName: "add-search",
      runId: "review-run",
      openSpec: { status: async () => status } as unknown as OpenSpecAdapter,
      modelStack: stack,
      now: () => new Date("2026-09-17T10:00:00.000Z"),
      runner: async (request) => {
        sessionIds.push(request.sessionId);
        return {
          review: createReviewArtifact({
            schemaVersion: 1,
            round: 1,
            reviewedAt: "2026-09-17T10:00:00.000Z",
            model: request.model,
            artifactDigest: "a".repeat(64),
            requestedVerdict: "APPROVE",
            criticalFindings: [],
            requiredChanges: [],
            recommendations: [],
          }),
          toolNames: ["muster_read", "muster_search"],
        };
      },
    });

    const persisted = parseReviewArtifact(await readFile(resolve(changeRoot, "review.md"), "utf8"), resolve(changeRoot, "review.md"));
    expect(outcome).toMatchObject({ status: "success", action: "review", runId: "review-run" });
    expect(persisted.model).toBe("openai/reviewer");
    expect(sessionIds).toHaveLength(1);
  });
  test("hands the judgment runtime to the reviewer and persists the extraction mark it returns", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-review-runtime-"));
    roots.push(root);
    const changeRoot = resolve(root, "openspec", "changes", "add-search");
    await mkdir(resolve(changeRoot, "specs", "search"), { recursive: true });
    await Promise.all([
      writeFile(resolve(changeRoot, "proposal.md"), "# Proposal\n"),
      writeFile(resolve(changeRoot, "design.md"), "# Design\n"),
      writeFile(resolve(changeRoot, "tasks.md"), "# Tasks\n"),
      writeFile(resolve(changeRoot, "specs", "search", "spec.md"), "# Search\n"),
    ]);
    const status = { changeName: "add-search", changeRoot } as unknown as OpenSpecStatus;
    const stack = synthesizeLegacyStack({
      architectModel: "openai/architect",
      builderModel: "openai/reviewer",
      architectThinking: "high",
      builderThinking: "high",
    });
    const judgment = createInertJudgmentRuntime();
    let seen: unknown;

    const outcome = await runProductionReview({
      cwd: root,
      changeName: "add-search",
      runId: "review-run",
      openSpec: { status: async () => status } as unknown as OpenSpecAdapter,
      modelStack: stack,
      judgment,
      now: () => new Date("2026-09-17T10:00:00.000Z"),
      runner: async (request) => {
        seen = request.judgment?.runtime;
        return {
          review: { verdict: "REVISE", criticalFindings: [], requiredChanges: ["Add a rollback."], recommendations: [] },
          toolNames: ["muster_read"],
          extraction: { recordId: "decision-abc" },
        };
      },
    });

    const persisted = parseReviewArtifact(await readFile(resolve(changeRoot, "review.md"), "utf8"), resolve(changeRoot, "review.md"));
    expect(seen).toBe(judgment);
    expect(outcome).toMatchObject({ status: "blocked", action: "review" });
    expect(persisted.extraction).toEqual({ recordId: "decision-abc" });
    expect(persisted.requiredChanges).toEqual(["Add a rollback."]);
  });
});

describe("production review with task quality findings", () => {
  const NOTE = "Task 1.2: its write scopes may not cover every file its description requires changing (probability 0.90).";

  function tasksMd(writes = "src/search/**"): string {
    const block = (id: string, dependsOn: string[]) => [
      `- [ ] ${id} Cap the results`,
      "",
      "  ```yaml harness-task",
      `  id: "${id}"`,
      `  dependsOn: ${JSON.stringify(dependsOn)}`,
      "  role: builder",
      "  reads: []",
      `  writes: ["${writes}"]`,
      '  requirements: ["Search is bounded"]',
      '  scenarios: ["Results are capped"]',
      '  verify: ["bun test"]',
      "  manual: null",
      "  ```",
      "",
    ].join("\n");
    return `## 1. Work\n\n${block("1.1", [])}\n${block("1.2", ["1.1"])}`;
  }

  async function setup(options: { mode?: "shadow" | "enforce"; recorded?: "current" | "stale" | "none"; enabled?: boolean; ticked?: boolean } = {}) {
    const root = await mkdtemp(resolve(tmpdir(), "muster-review-task-quality-"));
    roots.push(root);
    const changeRoot = resolve(root, "openspec", "changes", "add-search");
    await mkdir(resolve(changeRoot, "specs", "search"), { recursive: true });
    await Promise.all([
      writeFile(resolve(changeRoot, "proposal.md"), "# Proposal\n"),
      writeFile(resolve(changeRoot, "design.md"), "# Design\n"),
      writeFile(resolve(changeRoot, "tasks.md"), options.ticked ? tasksMd().replace("- [ ] 1.1", "- [x] 1.1") : tasksMd()),
      writeFile(resolve(changeRoot, "specs", "search", "spec.md"), "# Search\n"),
    ]);
    const store = createChangeUsageStore(root);
    const mode = options.mode ?? "enforce";
    if ((options.recorded ?? "current") !== "none") {
      // The assessment was made for these definitions, or for an earlier plan whose scope has since changed.
      const assessed = buildTaskQualityInput([
        { path: "proposal.md", content: "# Proposal" },
        { path: "tasks.md", content: options.recorded === "stale" ? tasksMd("src/other/**") : tasksMd() },
      ]);
      if (!assessed.ok) throw new Error(assessed.reason);
      const created = createDecisionRecord("add-search", {
        decision: "planning.task_quality",
        decisionVersion: 1,
        phase: "planning",
        mode,
        status: "answered",
        unavailableReason: null,
        requestedModel: "jev-1.13.0",
        reportedModel: "jev-1.13.0",
        answers: {},
        gate: { act: true, value: { findings: [{ kind: "scope", index: 2, probability: 0.9 }] } },
        wouldHaveActed: true,
        acted: mode === "enforce",
        spend: null,
        stateDigest: "sha256:0",
      });
      await writeDecisionRecord(store, "add-search", created);
      await bindTaskQualityRecord(store, "add-search", created.recordId, assessed);
    }
    const judgment = options.enabled === false
      ? createInertJudgmentRuntime()
      : createJudgmentRuntime({
        env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key", MUSTER_JEV_MODE: mode },
        store,
        client: createDeadClient("network"),
      });
    const prompts: string[] = [];
    const outcome = await runProductionReview({
      cwd: root,
      changeName: "add-search",
      runId: "review-run",
      openSpec: { status: async () => ({ changeName: "add-search", changeRoot }) } as unknown as OpenSpecAdapter,
      modelStack: synthesizeLegacyStack({
        architectModel: "openai/architect",
        builderModel: "openai/reviewer",
        architectThinking: "high",
        builderThinking: "high",
      }),
      judgment,
      now: () => new Date("2026-09-17T10:00:00.000Z"),
      runner: async (request) => {
        prompts.push(request.prompt);
        return {
          review: { verdict: "APPROVE", criticalFindings: [], requiredChanges: [], recommendations: [] },
          toolNames: ["muster_read"],
        };
      },
    });
    const review = parseReviewArtifact(await readFile(resolve(changeRoot, "review.md"), "utf8"), resolve(changeRoot, "review.md"));
    return { prompt: prompts[0]!, outcome, review };
  }

  test("current enforced findings appear in the prompt as unverified notes", async () => {
    const { prompt, review, outcome } = await setup();
    expect(prompt).toContain("Unverified automated notes about the task list");
    expect(prompt).toContain(`- ${NOTE}`);
    expect(outcome).toMatchObject({ status: "success", action: "review" });
    expect(review).toMatchObject({ verdict: "APPROVE", criticalFindings: [], requiredChanges: [], recommendations: [] });
  });

  test("ticking a checkbox does not detach the findings", async () => {
    const { prompt } = await setup({ ticked: true });
    expect(prompt).toContain(`- ${NOTE}`);
  });

  test("findings for changed task definitions are not shown", async () => {
    const { prompt } = await setup({ recorded: "stale" });
    expect(prompt).not.toContain("Unverified");
    expect(prompt).not.toContain(NOTE);
  });

  test("shadow findings are not shown", async () => {
    const { prompt } = await setup({ mode: "shadow" });
    expect(prompt).not.toContain("Unverified");
  });

  test("no record means no notes", async () => {
    const { prompt } = await setup({ recorded: "none" });
    expect(prompt).not.toContain("Unverified");
  });

  test("disabled judgment adds nothing to the prompt", async () => {
    const { prompt } = await setup({ enabled: false });
    expect(prompt).not.toContain("Unverified");
  });
});
