import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Lane } from "../../src/controller/lane.ts";
import type { PlanTask } from "../../src/planning/plan-schema.ts";
import { renderArtifacts, writeArtifacts } from "../../src/planning/render.ts";
import { lintChange, parseSpecRequirements } from "../../src/review/plan-lint.ts";
import { COMMAND_PROFILES } from "../../src/tools/command-profile.ts";
import { samplePlan } from "../planning/sample-plan.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const valid = { items: [{ id: "add-search", type: "change", valid: true, issues: [] }] } as never;

async function change(mutate?: (plan: ReturnType<typeof samplePlan>) => void) {
  const root = await mkdtemp(resolve(tmpdir(), "muster-plan-lint-"));
  directories.push(root);
  const plan = samplePlan();
  mutate?.(plan);
  await writeArtifacts(renderArtifacts(plan, root));
  return root;
}

async function edit(root: string, path: string, change: (text: string) => string) {
  const target = resolve(root, path);
  await writeFile(target, change(await readFile(target, "utf8")));
}

const lint = (root: string, lane: Lane = "medium", validate = async () => valid) =>
  lintChange({ changeRoot: root, changeName: "add-search", lane, profile: COMMAND_PROFILES.verification!, openSpec: { validate } });

const task = (id: string, overrides: Partial<PlanTask> = {}): PlanTask => ({
  id,
  group: "Toolbar",
  description: `Task ${id}`,
  dependsOn: [],
  reads: ["src/**"],
  writes: [`src/file-${id}.ts`],
  requirements: [{ capability: "toolbar-search", name: "The toolbar filters items" }],
  scenarios: ["Typing filters the list", "Clearing the box restores the list"],
  verify: ["bun test"],
  ...overrides,
});

describe("lintChange", () => {
  test("a rendered plan passes, and the result names the checks that ran", async () => {
    const result = await lint(await change());
    expect(result.errors).toEqual([]);
    expect(result.escalations).toEqual([]);
    expect(result.checks.length).toBeGreaterThan(5);
    expect(result.document?.tasks).toHaveLength(2);
    expect(result.requirements.map(({ name }) => name)).toEqual(["The toolbar filters items"]);
  });

  test("a missing artifact is an error", async () => {
    const root = await change();
    await rm(resolve(root, "design.md"));
    expect((await lint(root)).errors).toContain("design.md is missing");
  });

  test("references resolve against the real specifications", async () => {
    const root = await change();
    await edit(root, "tasks.md", (text) => text.replace('"toolbar-search: The toolbar filters items"', '"toolbar-search: The toolbar sorts items"'));
    const { errors } = await lint(root);
    expect(errors).toContain('task 1.1: requirement "toolbar-search: The toolbar sorts items" is not in any specification of this change');
  });

  test("a cited scenario must be under a requirement the task cites", async () => {
    const root = await change();
    await edit(root, "tasks.md", (text) => text.replace('scenarios: ["Typing filters the list"]', 'scenarios: ["Typing filters the list", "Scenario nobody defined"]'));
    expect((await lint(root)).errors).toContain('task 1.2: scenario "Scenario nobody defined" is not under a requirement the task cites');
  });

  test("an uncovered scenario is named", async () => {
    const root = await change();
    await edit(root, "specs/toolbar-search/spec.md", (text) => `${text}\n\n#### Scenario: Pressing escape clears the box\n\n- **WHEN** the user presses escape\n- **THEN** the box is cleared\n`);
    expect((await lint(root)).errors).toContain('scenario "Pressing escape clears the box" of requirement "toolbar-search: The toolbar filters items" is cited by no task');
  });

  test("a credential file in a write scope", async () => {
    const root = await change((plan) => { plan.tasks[0] = { ...plan.tasks[0]!, writes: ["src/toolbar.ts", ".env"] }; });
    expect((await lint(root)).errors).toContain('task 1.1: write scope ".env" names a credential file');
  });

  test("a write scope inside .git", async () => {
    const root = await change((plan) => { plan.tasks[0] = { ...plan.tasks[0]!, writes: [".git/hooks/pre-commit"] }; });
    expect((await lint(root)).errors).toContain('task 1.1: write scope ".git/hooks/pre-commit" is inside .git');
  });

  test("a verification command the profile forbids", async () => {
    const root = await change((plan) => { plan.tasks[0] = { ...plan.tasks[0]!, verify: ["cargo test"] }; });
    const { errors } = await lint(root);
    expect(errors.some((error) => error.startsWith('task 1.1: verification command "cargo test"'))).toBeTrue();
  });

  test("a dependency cycle", async () => {
    const root = await change();
    await edit(root, "tasks.md", (text) => text.replace('dependsOn: []', 'dependsOn: ["1.2"]'));
    expect((await lint(root)).errors.some((error) => error.startsWith("tasks form a dependency cycle:"))).toBeTrue();
  });

  test("a tasks file that does not parse is an error", async () => {
    const root = await change();
    await writeFile(resolve(root, "tasks.md"), "## 1. Toolbar\n\n- [ ] 1.1 A task with no metadata\n");
    const { errors, document } = await lint(root);
    expect(errors.some((error) => error.startsWith("tasks.md:"))).toBeTrue();
    expect(document).toBeNull();
  });

  test("a failing strict OpenSpec validation is an error, and so is one that cannot run", async () => {
    const root = await change();
    const failing = await lint(root, "medium", async () => ({ items: [{ id: "add-search", type: "change", valid: false, issues: [{}, {}] }] }) as never);
    expect(failing.errors).toContain("openspec validate --strict: add-search is invalid (2 issue(s))");
    const crashing = await lint(root, "medium", async () => { throw new Error("cli missing"); });
    expect(crashing.errors).toContain("openspec validate --strict could not run: cli missing");
  });

  test("every problem is reported in one pass", async () => {
    const root = await change((plan) => { plan.tasks[0] = { ...plan.tasks[0]!, verify: ["cargo test"], writes: [".env"] }; });
    await rm(resolve(root, "design.md"));
    expect((await lint(root)).errors.length).toBeGreaterThanOrEqual(3);
  });

  test("too many tasks for small escalates instead of failing, and medium allows them", async () => {
    const root = await change((plan) => { plan.tasks = [task("1.1"), task("1.2"), task("1.3")]; });
    const small = await lint(root, "small");
    expect(small.errors).toEqual([]);
    expect(small.escalations).toEqual(["the plan has 3 tasks and the small lane allows 2"]);
    expect((await lint(root, "medium")).escalations).toEqual([]);
  });

  test("a manual task on the small lane escalates", async () => {
    const root = await change((plan) => {
      plan.tasks[1] = {
        ...plan.tasks[1]!,
        role: "manual",
        manual: { category: "authentication", reason: "Sign in", instructions: ["Sign in yourself"], expectedOutcome: "Signed in", resumeTarget: "1.2" },
      };
    });
    expect((await lint(root, "small")).escalations).toEqual(["the plan has manual task(s) 1.2, which the small lane does not allow"]);
    expect((await lint(root, "large")).escalations).toEqual([]);
  });
});

describe("parseSpecRequirements", () => {
  test("reads requirements and the scenarios under each", () => {
    const parsed = parseSpecRequirements("cap", "## ADDED Requirements\n\n### Requirement: One\n\nOne SHALL work.\n\n#### Scenario: A\n\n- **WHEN** x\n- **THEN** y\n\n#### Scenario: B\n\n- **WHEN** z\n- **THEN** w\n\n### Requirement: Two\n\nTwo SHALL work.\n");
    expect(parsed.map(({ name, scenarios }) => [name, scenarios.map((scenario) => scenario.name)])).toEqual([["One", ["A", "B"]], ["Two", []]]);
    expect(parsed[0]!.text).toBe("One SHALL work.");
  });
});
