import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { validateAgainstOwnReferences } from "../../src/execution/load-tasks.ts";
import { renderArtifacts, writeArtifacts } from "../../src/planning/render.ts";
import { runProcess } from "../../src/shared/process.ts";
import { samplePlan, sampleSmallPlan } from "./sample-plan.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const golden = resolve(import.meta.dir, "golden");
const openspecAvailable = (await runProcess("openspec", ["--version"], { cwd: import.meta.dir, timeoutMs: 20_000 }).catch(() => null))?.exitCode === 0;
const byRelativePath = (root: string, artifacts: ReturnType<typeof renderArtifacts>) =>
  Object.fromEntries(artifacts.map((artifact) => [relative(root, artifact.path).replaceAll("\\", "/"), artifact.content]));

describe("renderArtifacts", () => {
  test("renders the four artifacts, one spec per capability, at fixed paths", () => {
    const plan = samplePlan();
    plan.capabilities.new.push("toolbar-help");
    plan.requirements.push({
      capability: "toolbar-help",
      name: "The toolbar explains itself",
      text: "The toolbar SHALL show a hint.",
      scenarios: [{ name: "Hover shows the hint", when: "the user hovers", then: "the hint shows" }],
    });
    const rendered = byRelativePath("/change", renderArtifacts(plan, "/change"));
    expect(Object.keys(rendered).sort()).toEqual([
      "design.md",
      "proposal.md",
      "specs/toolbar-help/spec.md",
      "specs/toolbar-search/spec.md",
      "tasks.md",
    ]);
  });

  test("the task list parses and validates with the existing task loader", () => {
    const rendered = byRelativePath("/change", renderArtifacts(samplePlan(), "/change"));
    const document = validateAgainstOwnReferences(rendered["tasks.md"]!, "/change/tasks.md");
    expect(document.tasks.map((task) => task.id)).toEqual(["1.1", "1.2"]);
    expect(document.tasks[1]).toMatchObject({
      dependsOn: ["1.1"],
      role: "builder",
      requirements: ["toolbar-search: The toolbar filters items"],
      verify: ["bun run docs:check"],
      manual: null,
    });
    expect(document.phases.map((phase) => phase.title)).toEqual(["Toolbar"]);
  });

  test("a manual task keeps its manual block", () => {
    const plan = samplePlan();
    plan.tasks[1] = {
      ...plan.tasks[1]!,
      role: "manual",
      manual: {
        category: "authentication",
        reason: "Sign in to the staging service",
        instructions: ["Sign in with your own account"],
        expectedOutcome: "The session is authenticated",
        resumeTarget: "1.2",
      },
    };
    const rendered = byRelativePath("/change", renderArtifacts(plan, "/change"));
    const document = validateAgainstOwnReferences(rendered["tasks.md"]!, "/change/tasks.md");
    expect(document.tasks[1]).toMatchObject({ role: "manual", manual: { category: "authentication", resumeTarget: "1.2" } });
  });

  test("each spec has scenarios in the required heading format", () => {
    const spec = byRelativePath("/change", renderArtifacts(samplePlan(), "/change"))["specs/toolbar-search/spec.md"]!;
    expect(spec).toContain("## ADDED Requirements");
    expect(spec.match(/^#### Scenario: .+$/gm)).toHaveLength(2);
    expect(spec.match(/^- \*\*WHEN\*\* .+$/gm)).toHaveLength(2);
    expect(spec.match(/^- \*\*THEN\*\* .+$/gm)).toHaveLength(2);
  });

  test("modified, removed and renamed requirements use the delta formats", () => {
    const plan = samplePlan();
    plan.capabilities.modified.push("toolbar-search");
    plan.requirements.push(
      { capability: "toolbar-search", name: "Old behavior", kind: "REMOVED", text: "No longer needed.", migration: "Use the search box." },
      { capability: "toolbar-search", name: "New name", kind: "RENAMED", text: "Renamed.", renamedFrom: "Old name" },
      { capability: "toolbar-search", name: "Sorted results", kind: "MODIFIED", text: "Results SHALL be sorted.", scenarios: [{ name: "Sorted", when: "results show", then: "they are sorted" }] },
    );
    const spec = byRelativePath("/change", renderArtifacts(plan, "/change"))["specs/toolbar-search/spec.md"]!;
    expect(spec).toContain("## MODIFIED Requirements");
    expect(spec).toContain("### Requirement: Old behavior\n**Reason**: No longer needed.\n**Migration**: Use the search box.");
    expect(spec).toContain("## RENAMED Requirements\n\n- FROM: `### Requirement: Old name`\n- TO: `### Requirement: New name`");
    expect(spec.indexOf("## ADDED")).toBeLessThan(spec.indexOf("## MODIFIED"));
    expect(spec.indexOf("## MODIFIED")).toBeLessThan(spec.indexOf("## REMOVED"));
    expect(spec.indexOf("## REMOVED")).toBeLessThan(spec.indexOf("## RENAMED"));
  });

  test("a small plan without a design gets a one-line design", () => {
    const rendered = byRelativePath("/change", renderArtifacts(sampleSmallPlan(), "/change"));
    expect(rendered["design.md"]).toContain("No decisions beyond the proposal are needed.");
    expect(Object.keys(rendered)).toContain("specs/cli/spec.md");
  });

  test("the session cannot choose a path: capability names that are not slugs are refused", () => {
    for (const capability of ["../evil", "a/b", "Upper", ""]) {
      const plan = samplePlan();
      plan.requirements[0] = { ...plan.requirements[0]!, capability };
      expect(() => renderArtifacts(plan, "/change")).toThrow();
    }
  });

  test("every path stays inside the change root", () => {
    for (const artifact of renderArtifacts(samplePlan(), "/some/change/root")) {
      expect(relative("/some/change/root", artifact.path).startsWith("..")).toBeFalse();
    }
  });

  test("the rendered artifacts match their goldens", async () => {
    for (const [name, plan] of [["full", samplePlan()], ["small", sampleSmallPlan()]] as const) {
      const root = resolve("/change", name);
      for (const artifact of renderArtifacts(plan, root)) {
        const expected = await readFile(resolve(golden, name, relative(root, artifact.path)), "utf8");
        expect(artifact.content, `${name}/${relative(root, artifact.path)}`).toBe(expected);
      }
    }
  });
});

describe("writeArtifacts", () => {
  test("writes every artifact, creating directories, each ending in a newline", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-plan-render-"));
    directories.push(root);
    await writeArtifacts(renderArtifacts(samplePlan(), root));
    for (const path of ["proposal.md", "design.md", "tasks.md", "specs/toolbar-search/spec.md"]) {
      expect((await readFile(resolve(root, path), "utf8")).endsWith("\n"), path).toBeTrue();
    }
  });

  test.skipIf(!openspecAvailable)("the artifacts pass strict OpenSpec validation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-plan-openspec-"));
    directories.push(root);
    await runProcess("git", ["init"], { cwd: root, timeoutMs: 10_000 });
    expect((await runProcess("openspec", ["init", "--tools", "none"], { cwd: root, timeoutMs: 60_000 })).exitCode).toBe(0);
    expect((await runProcess("openspec", ["new", "change", "demo"], { cwd: root, timeoutMs: 30_000 })).exitCode).toBe(0);
    await writeArtifacts(renderArtifacts(samplePlan(), resolve(root, "openspec", "changes", "demo")));
    const result = await runProcess("openspec", ["validate", "demo", "--strict"], { cwd: root, timeoutMs: 30_000 });
    expect(result.stdout + result.stderr).toContain("is valid");
    expect(result.exitCode).toBe(0);
  }, 60_000);
});
