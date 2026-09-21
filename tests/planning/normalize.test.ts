import { describe, expect, test } from "bun:test";
import { normalizePlan } from "../../src/planning/normalize.ts";
import type { PlanTask } from "../../src/planning/plan-schema.ts";
import { validatePlan } from "../../src/planning/plan-validate.ts";
import { COMMAND_PROFILES } from "../../src/tools/command-profile.ts";
import { samplePlan } from "./sample-plan.ts";

const requirement = { capability: "toolbar-search", name: "The toolbar filters items" };
const task = (id: string, overrides: Partial<PlanTask> = {}): PlanTask => ({
  id,
  group: "Toolbar",
  description: `Task ${id}`,
  dependsOn: [],
  reads: [],
  writes: ["src/toolbar.ts", "tests/toolbar.test.ts"],
  requirements: [requirement],
  scenarios: ["Typing filters the list"],
  verify: ["bun test tests/toolbar.test.ts"],
  ...overrides,
});
const planOf = (...tasks: PlanTask[]) => ({ ...samplePlan(), tasks });
const ids = (plan: ReturnType<typeof samplePlan>) => plan.tasks.map((entry) => entry.id);

describe("normalizePlan", () => {
  test("a same-scope chain merges into the first task and says so", () => {
    const { plan, notes } = normalizePlan(planOf(task("1.1"), task("1.2", { dependsOn: ["1.1"] })));
    expect(ids(plan)).toEqual(["1.1"]);
    expect(notes).toEqual(["merged 1.2 into 1.1: same write scope"]);
    expect(plan.tasks[0]!.description).toBe("Task 1.1 Then: Task 1.2");
  });

  test("a chain of three collapses to one", () => {
    const { plan, notes } = normalizePlan(planOf(task("1.1"), task("1.2", { dependsOn: ["1.1"] }), task("1.3", { dependsOn: ["1.2"] })));
    expect(ids(plan)).toEqual(["1.1"]);
    expect(notes).toEqual(["merged 1.2 into 1.1: same write scope", "merged 1.3 into 1.1: same write scope"]);
    expect(plan.tasks[0]!.description).toBe("Task 1.1 Then: Task 1.2 Then: Task 1.3");
  });

  test("different write scopes do not merge, and equal scopes match as sets of normalized paths", () => {
    expect(ids(normalizePlan(planOf(task("1.1"), task("1.2", { dependsOn: ["1.1"], writes: ["src/other.ts"] }))).plan)).toEqual(["1.1", "1.2"]);
    expect(ids(normalizePlan(planOf(task("1.1"), task("1.2", { dependsOn: ["1.1"], writes: ["src/toolbar.ts", "tests/toolbar.test.ts", "docs/extra.md"] }))).plan)).toEqual(["1.1", "1.2"]);
    const reordered = normalizePlan(planOf(task("1.1"), task("1.2", { dependsOn: ["1.1"], writes: ["./tests/toolbar.test.ts", "src/toolbar.ts"] })));
    expect(ids(reordered.plan)).toEqual(["1.1"]);
  });

  test("a manual task is never merged", () => {
    const manual = task("1.2", {
      dependsOn: ["1.1"],
      role: "manual",
      manual: { category: "authentication", reason: "Sign in", instructions: ["Sign in"], expectedOutcome: "Signed in", resumeTarget: "1.2" },
    });
    expect(ids(normalizePlan(planOf(task("1.1"), manual)).plan)).toEqual(["1.1", "1.2"]);
    expect(ids(normalizePlan(planOf(task("1.1", { role: "reviewer" }), task("1.2", { dependsOn: ["1.1"] }))).plan)).toEqual(["1.1", "1.2"]);
  });

  test("a fan-out is not merged, nor is a task that depends on more than the first", () => {
    const fanOut = planOf(task("1.1"), task("1.2", { dependsOn: ["1.1"] }), task("1.3", { dependsOn: ["1.1"] }));
    expect(ids(normalizePlan(fanOut).plan)).toEqual(["1.1", "1.2", "1.3"]);
    const join = planOf(task("1.1"), task("1.2", { writes: ["src/other.ts"] }), task("1.3", { dependsOn: ["1.1", "1.2"] }));
    expect(ids(normalizePlan(join).plan)).toEqual(["1.1", "1.2", "1.3"]);
  });

  test("a task with no write scope has nothing to share and stays separate", () => {
    expect(ids(normalizePlan(planOf(task("1.1", { writes: [] }), task("1.2", { dependsOn: ["1.1"], writes: [] }))).plan)).toEqual(["1.1", "1.2"]);
  });

  test("references and commands are unioned, deduplicated, in first-seen order", () => {
    const other = { capability: "toolbar-search", name: "The toolbar clears" };
    const { plan } = normalizePlan(planOf(
      task("1.1", { reads: ["src/**"], scenarios: ["A", "B"], verify: ["bun test a", "bun test b"] }),
      task("1.2", { dependsOn: ["1.1"], reads: ["docs/**", "src/**"], requirements: [requirement, other], scenarios: ["B", "C"], verify: ["bun test b", "bun run typecheck"] }),
    ));
    const [merged] = plan.tasks;
    expect(merged!.reads).toEqual(["src/**", "docs/**"]);
    expect(merged!.requirements).toEqual([requirement, other]);
    expect(merged!.scenarios).toEqual(["A", "B", "C"]);
    expect(merged!.verify).toEqual(["bun test a", "bun test b", "bun run typecheck"]);
  });

  test("dependents of a merged task are rewired to the survivor", () => {
    const { plan } = normalizePlan(planOf(
      task("1.1"),
      task("1.2", { dependsOn: ["1.1"] }),
      task("2.1", { dependsOn: ["1.2"], writes: ["docs/toolbar.md"], group: "Docs" }),
      task("2.2", { dependsOn: ["1.2", "2.1"], writes: ["docs/more.md"], group: "Docs" }),
    ));
    expect(ids(plan)).toEqual(["1.1", "2.1", "2.2"]);
    expect(plan.tasks[1]!.dependsOn).toEqual(["1.1"]);
    expect(plan.tasks[2]!.dependsOn).toEqual(["1.1", "2.1"]);
  });

  test("a normalized plan still validates, and coverage is preserved", () => {
    const original = samplePlan();
    original.tasks = [
      { ...original.tasks[0]!, writes: ["src/toolbar.ts"] },
      { ...original.tasks[1]!, dependsOn: ["1.1"], writes: ["src/toolbar.ts"], scenarios: ["Clearing the box restores the list"] },
    ];
    const { plan } = normalizePlan(original);
    expect(plan.tasks).toHaveLength(1);
    expect(validatePlan(plan, { verificationProfile: COMMAND_PROFILES.verification! })).toEqual([]);
    expect(new Set(plan.tasks.flatMap(({ scenarios }) => scenarios))).toEqual(new Set(original.tasks.flatMap(({ scenarios }) => scenarios)));
  });

  test("a plan with nothing to merge is returned unchanged with no notes", () => {
    const original = samplePlan();
    const { plan, notes } = normalizePlan(original);
    expect(plan.tasks).toEqual(original.tasks);
    expect(notes).toEqual([]);
  });
});
