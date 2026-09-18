import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createProductionChangeCommandDependencies,
  loadProductionChangeSnapshot,
  recordChangeAgentRuns,
} from "../../src/change/dependencies.ts";
import { renderExplorePrompt, resolveExploreModel } from "../../src/change/phases/exploration.ts";
import { changeSubcommands } from "../../src/change/change-command.ts";
import { loadChangeUsageSummary, createChangeUsageStore } from "../../src/persistence/change-usage-store.ts";
import { runProcess } from "../../src/shared/process.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function repositoryWithChange(changeName: string): Promise<string> {
  const root = await mktempRoot();
  await git(root, "init");
  await git(root, "config", "user.email", "muster@example.invalid");
  await git(root, "config", "user.name", "Muster Tests");
  const changeRoot = resolve(root, "openspec", "changes", changeName);
  await mkdir(changeRoot, { recursive: true });
  await writeFile(
    resolve(changeRoot, "tasks.md"),
    [
      "## 1. Do the thing",
      "",
      "- [ ] 1.1 First task",
      "",
      "  ```yaml harness-task",
      "  id: \"1.1\"",
      "  dependsOn: []",
      "  role: builder",
      "  reads: []",
      "  writes: []",
      "  requirements: []",
      "  scenarios: []",
      "  verify: []",
      "  manual: null",
      "  ```",
      "",
      "- [x] 1.2 Second task",
      "",
      "  ```yaml harness-task",
      "  id: \"1.2\"",
      "  dependsOn: [\"1.1\"]",
      "  role: builder",
      "  reads: []",
      "  writes: []",
      "  requirements: []",
      "  scenarios: []",
      "  verify: []",
      "  manual: null",
      "  ```",
      "",
    ].join("\n"),
  );
  await git(root, "add", ".");
  await git(root, "commit", "-m", "add change");
  return root;
}

async function mktempRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "muster-production-runtime-"));
  temporaryDirectories.push(root);
  return root;
}

describe("production change snapshot", () => {
  test("default production dependencies provide every advertised handler", () => {
    const dependencies = createProductionChangeCommandDependencies({ cwd: process.cwd(), argv: [] });
    for (const action of changeSubcommands) {
      expect(dependencies.handlers[action], `missing production handler for ${action}`).toBeFunction();
    }
  });

  test("invocation dependency construction follows the host cwd and cancellation signal", async () => {
    const root = await mktempRoot();
    await mkdir(resolve(root, "openspec", "changes"), { recursive: true });
    const abort = new AbortController();
    const calls: Array<{ cwd: string; signal?: AbortSignal; runId?: string }> = [];
    const dependencies = createProductionChangeCommandDependencies({
      cwd: "C:\\extension-startup",
      argv: [],
      runners: {
        planning: async (options) => {
          calls.push({ cwd: options.cwd, signal: options.signal, runId: options.runId });
          return { status: "success", action: options.phase, changeName: options.changeName, summary: "planned" };
        },
      },
    });
    const invocation = await dependencies.forInvocation?.({
      cwd: root,
      signal: abort.signal,
      ui: { notify: () => undefined },
    });
    const command = { action: "propose" as const, changeName: "new-change", arguments: ["Goal"] };
    const run = await invocation!.createRunContext?.(command, {
      cwd: root,
      signal: abort.signal,
      ui: { notify: () => undefined },
    });
    await invocation!.handlers.propose?.(command, {
      cwd: root,
      signal: abort.signal,
      run,
      ui: { notify: () => undefined },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(root);
    expect(calls[0]?.signal).toBe(abort.signal);
    expect(calls[0]?.runId).toBe(run?.runId);
    expect(run?.planningHome).toBe(await realpath(root));
  });

  test("returns null when the change does not exist", async () => {
    const root = await mktempRoot();
    await git(root, "init");
    await git(root, "config", "user.email", "muster@example.invalid");
    await git(root, "config", "user.name", "Muster Tests");
    await writeFile(resolve(root, "readme.txt"), "hi\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");

    expect(await loadProductionChangeSnapshot({ cwd: root, changeName: "missing-change" })).toBeNull();
  });

  test("derives lifecycle and task state from real Git and tasks.md", async () => {
    const root = await repositoryWithChange("add-search");

    const snapshot = await loadProductionChangeSnapshot({ cwd: root, changeName: "add-search" });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.changeName).toBe("add-search");
    expect(snapshot!.taskStates).toEqual({ "1.1": false, "1.2": true });
    expect(snapshot!.pendingCheckpointIds).toEqual([]);
  });

  test("change resolution is read-only until the caller activates the validated change", async () => {
    const root = await repositoryWithChange("add-search");
    const dependencies = createProductionChangeCommandDependencies({ cwd: root });

    expect(await dependencies.resolveChangeName(undefined)).toBeNull();
    expect(await dependencies.resolveChangeName("add-search", "status")).toBe("add-search");
    expect(await dependencies.resolveChangeName(undefined)).toBeNull();
    await dependencies.activateChange?.("add-search");
    expect(await dependencies.resolveChangeName(undefined)).toBe("add-search");
  });

  test("recorded agent runs are attributable to the change and summarized", async () => {
    const root = await repositoryWithChange("add-search");
    await recordChangeAgentRuns({
      cwd: root,
      changeName: "add-search",
      phase: "planning",
      runs: [
        { role: "ARCHITECT", model: "openai/gpt-5", tokensIn: 100, tokensOut: 50, costUsd: 0.02, ms: 500 },
      ],
    });

    const store = createChangeUsageStore(root);
    const summary = await loadChangeUsageSummary(store, "add-search");

    expect(summary?.total.invocations).toBe(1);
    expect(summary?.byPhase.planning.invocations).toBe(1);

    const dependencies = createProductionChangeCommandDependencies({ cwd: root });
    const usageViaDependencies = await dependencies.loadChangeUsage?.("add-search");
    expect(usageViaDependencies?.total.invocations).toBe(1);
  });
});

describe("explore agent wiring", () => {
  test("resolveExploreModel prefers MUSTER_EXPLORE_MODEL over the shipped default", () => {
    expect(resolveExploreModel({}, [])).toBe("anthropic/claude-fable-5");
    expect(resolveExploreModel({ MUSTER_EXPLORE_MODEL: " openai/gpt-5.6-sol " }, [])).toBe("openai/gpt-5.6-sol");
  });

  test("resolveExploreModel follows --fh-config's architect slot ahead of the shipped default", async () => {
    const root = await mktempRoot();
    const configPath = resolve(root, "model-stack.yaml");
    await writeFile(
      configPath,
      [
        "slots:",
        "  - name: architect",
        "    model: github-copilot/claude-sonnet-5",
        "    architect: true",
        "    thinking: high",
        "  - name: builder",
        "    model: github-copilot/claude-sonnet-5",
        "    primary: true",
        "",
      ].join("\n"),
    );
    expect(resolveExploreModel({}, ["--fh-config", configPath])).toBe("github-copilot/claude-sonnet-5");
  });

  test("resolveExploreModel falls back to --architect when no --fh-config is set", () => {
    expect(resolveExploreModel({}, ["--architect", "openai/gpt-5.6-sol"])).toBe("openai/gpt-5.6-sol");
  });

  test("renderExplorePrompt appends context/facts sections only when non-empty", () => {
    expect(renderExplorePrompt({
      phase: "explore",
      access: "read",
      prompt: "Why does X fail?",
      authoritativeContext: {},
      supplementalFacts: [],
    })).toBe("Why does X fail?");

    const rendered = renderExplorePrompt({
      phase: "explore",
      access: "read",
      prompt: "Why does X fail?",
      authoritativeContext: { changeName: "add-search" },
      supplementalFacts: [{ key: "pitfall", value: "flaky", source: "hindsight", authority: "supplemental" }],
    });
    expect(rendered).toContain("Why does X fail?");
    expect(rendered).toContain("AUTHORITATIVE CONTEXT");
    expect(rendered).toContain("add-search");
    expect(rendered).toContain("SUPPLEMENTAL FACTS");
    expect(rendered).toContain("pitfall");
  });
});
