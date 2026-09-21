import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../src/agents/model-stack.ts";
import { runProductionReview } from "../../src/change/phases/review.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecStatus } from "../../src/openspec/protocol.ts";
import { createInertJudgmentRuntime, createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { createDecisionRecord, writeDecisionRecord } from "../../src/judgment/audit.ts";
import { createDeadClient } from "../helpers/scripted-judgment.ts";
import { createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { createReviewArtifact, parseReviewArtifact } from "../../src/review/review-artifact.ts";
import { openSpecFor, writeValidPlan } from "../helpers/plan-fixture.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("production review runtime", () => {
  test("dispatches the production review controller with a fresh different-model reviewer", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-review-runtime-"));
    roots.push(root);
    const changeRoot = resolve(root, "openspec", "changes", "add-search");
    await writeValidPlan(changeRoot);
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
      openSpec: { status: async () => status, validate: openSpecFor(changeRoot).validate } as unknown as OpenSpecAdapter,
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
    await writeValidPlan(changeRoot);
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
      openSpec: { status: async () => status, validate: openSpecFor(changeRoot).validate } as unknown as OpenSpecAdapter,
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
