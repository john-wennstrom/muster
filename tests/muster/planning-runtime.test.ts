import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { synthesizeLegacyStack } from "../../extensions/fusion-harness/modules/model-stack.ts";
import { runProductionPlanning } from "../../src/muster/planning-runtime.ts";
import type { OpenSpecAdapter } from "../../src/openspec/adapter.ts";
import type { OpenSpecStatus } from "../../src/openspec/protocol.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "muster-planning-runtime-"));
  roots.push(root);
  const changeRoot = resolve(root, "openspec", "changes", "add-search");
  await mkdir(changeRoot, { recursive: true });
  const status: OpenSpecStatus = {
    changeName: "add-search",
    schemaName: "spec-driven",
    planningHome: { kind: "repo", root, changesDir: resolve(root, "openspec", "changes"), defaultSchema: "spec-driven" },
    changeRoot,
    artifactPaths: {},
    isPlanningComplete: false,
    isComplete: false,
    applyRequires: ["tasks"],
    nextSteps: [],
    actionContext: {
      mode: "repo-local",
      sourceOfTruth: "repo",
      planningArtifacts: ["proposal", "specs", "design", "tasks"],
      linkedContext: [],
      allowedEditRoots: [root],
      requiresAffectedAreaSelection: false,
      constraints: [],
    },
    artifacts: [],
    root: { path: root, source: "nearest" },
  };
  const adapter = { status: async () => status } as unknown as OpenSpecAdapter;
  const modelStack = synthesizeLegacyStack({
    architectModel: "openai/architect",
    builderModel: "openai/builder",
    architectThinking: "high",
    builderThinking: "high",
  });
  return { root, changeRoot, adapter, modelStack };
}

describe("production planning runtime", () => {
  test("runs the planning controller and writes only validated OpenSpec artifacts", async () => {
    const subject = await fixture();
    const stages: string[] = [];
    const outcome = await runProductionPlanning({
      cwd: subject.root,
      changeName: "add-search",
      phase: "refine",
      prompt: "Add bounded search",
      runId: "planning-run",
      openSpec: subject.adapter,
      modelStack: subject.modelStack,
      runAgent: async (request, _status, slot) => {
        stages.push(`${request.stage}:${slot.model}`);
        return {
          model: slot.model,
          content: JSON.stringify({ artifacts: [
            { path: "proposal.md", content: "# Proposal" },
            { path: "design.md", content: "# Design" },
            { path: "specs/search/spec.md", content: "## Purpose\nSearch behavior contract.\n\n## ADDED Requirements" },
            { path: "tasks.md", content: "## 1. Search\n" },
          ] }),
        };
      },
    });

    expect(stages).toEqual(["synthesis:openai/architect"]);
    expect(outcome).toMatchObject({ status: "success", action: "refine", runId: "planning-run" });
    expect(await readFile(resolve(subject.changeRoot, "proposal.md"), "utf8")).toBe("# Proposal\n");
    expect(await readFile(resolve(subject.changeRoot, "specs", "search", "spec.md"), "utf8")).toContain("Search behavior");
  });

  test("rejects an incomplete synthesis before writing any artifact", async () => {
    const subject = await fixture();
    let error: unknown;
    try {
      await runProductionPlanning({
        cwd: subject.root,
        changeName: "add-search",
        phase: "refine",
        prompt: "Incomplete",
        openSpec: subject.adapter,
        modelStack: subject.modelStack,
        runAgent: async (_request, _status, slot) => ({
          model: slot.model,
          content: JSON.stringify({ artifacts: [
            { path: "proposal.md", content: "# Proposal" },
            { path: "design.md", content: "# Design" },
            { path: "tasks.md", content: "## Tasks" },
          ] }),
        }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    expect(readFile(resolve(subject.changeRoot, "proposal.md"), "utf8")).rejects.toThrow();
  });
});
