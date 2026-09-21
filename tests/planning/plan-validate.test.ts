import { describe, expect, test } from "bun:test";
import { describePlanSchema, parsePlan, planSchema, type PlanTask } from "../../src/planning/plan-schema.ts";
import { validatePlan } from "../../src/planning/plan-validate.ts";
import { COMMAND_PROFILES } from "../../src/tools/command-profile.ts";
import { samplePlan } from "./sample-plan.ts";

const verificationProfile = COMMAND_PROFILES.verification!;
const check = (plan = samplePlan()) => validatePlan(plan, { verificationProfile });
const withTask = (index: number, change: Partial<PlanTask>) => {
  const plan = samplePlan();
  plan.tasks[index] = { ...plan.tasks[index]!, ...change };
  return plan;
};
const messagesAt = (errors: ReturnType<typeof check>, path: string) =>
  errors.filter((error) => error.path === path).map((error) => error.message);

describe("parsePlan", () => {
  test("a plan is parsed from an answer with harmless prose or a fence around it", () => {
    const json = JSON.stringify(samplePlan());
    for (const text of [json, `Here is the plan.\n\n${json}`, `\`\`\`json\n${json}\n\`\`\``]) {
      const parsed = parsePlan(text);
      expect(parsed.ok).toBeTrue();
      expect(parsed.ok && parsed.plan.disposition).toBe("plan");
    }
  });

  test("a clarification and an already-satisfied report are plans too", () => {
    const clarification = parsePlan(JSON.stringify({
      disposition: "needs_clarification",
      summary: "Ambiguous.",
      question: "Which toolbar do you mean?",
      evidence: [{ path: "src/toolbar.ts", reason: "There are two." }],
    }));
    expect(clarification).toMatchObject({ ok: true, plan: { disposition: "needs_clarification" } });
    const satisfied = parsePlan(JSON.stringify({ disposition: "already_satisfied", summary: "It exists.", evidence: [] }));
    expect(satisfied).toMatchObject({ ok: true, plan: { disposition: "already_satisfied" } });
  });

  test("exactly one JSON object is required", () => {
    const json = JSON.stringify(samplePlan());
    expect(parsePlan("no json at all")).toMatchObject({ ok: false, errors: [{ message: "expected exactly one JSON object, found 0" }] });
    expect(parsePlan(`${json}\n${json}`)).toMatchObject({ ok: false, errors: [{ message: "expected exactly one JSON object, found 2" }] });
  });

  test("schema errors carry the path of the field", () => {
    const plan = JSON.parse(JSON.stringify(samplePlan()));
    plan.tasks[1].verify = [];
    plan.requirements[0].capability = "Not Kebab";
    const parsed = parsePlan(JSON.stringify(plan));
    expect(parsed.ok).toBeFalse();
    const errors = parsed.ok ? [] : parsed.errors;
    expect(errors.map((error) => error.path)).toEqual(expect.arrayContaining(["tasks[1].verify", "requirements[0].capability"]));
  });

  test("an unknown field is rejected, so a misspelled one cannot be silently dropped", () => {
    const plan = { ...samplePlan(), extra: true };
    expect(parsePlan(JSON.stringify(plan)).ok).toBeFalse();
  });

  test("the prompt describes the validated schema", () => {
    const text = describePlanSchema();
    const schema = JSON.parse(text);
    expect(JSON.stringify(schema)).toContain("needs_clarification");
    for (const field of ["requirements", "scenarios", "verify", "dependsOn", "already_satisfied"]) {
      expect(text).toContain(field);
    }
    // The description is generated from the schema that validates the answer, so a valid plan satisfies both.
    expect(planSchema.safeParse(samplePlan()).success).toBeTrue();
  });
});

describe("validatePlan", () => {
  test("a good plan has no errors", () => {
    expect(check()).toEqual([]);
  });

  test("a verification command the host will refuse", () => {
    const errors = check(withTask(0, { verify: ["cargo test"] }));
    expect(messagesAt(errors, "tasks[0].verify[0]")[0]).toContain('Executable "cargo" is not allowed by profile verification');
  });

  test("a verification command with a shell operator", () => {
    const errors = check(withTask(0, { verify: ["bun test && rm -rf ."] }));
    expect(messagesAt(errors, "tasks[0].verify[0]")[0]).toContain("shell operators");
  });

  test("an unresolvable requirement reference", () => {
    const errors = check(withTask(0, { requirements: [{ capability: "toolbar-search", name: "The toolbar sorts items" }] }));
    expect(messagesAt(errors, "tasks[0].requirements[0]")).toEqual(['references unknown requirement "toolbar-search: The toolbar sorts items"']);
  });

  test("a cited scenario must exist under a cited requirement", () => {
    const errors = check(withTask(0, { scenarios: ["Typing filters the list", "No such scenario"] }));
    expect(messagesAt(errors, "tasks[0].scenarios[1]")).toEqual(['scenario "No such scenario" is not under any requirement this task cites']);
  });

  test("a dependency cycle", () => {
    const plan = withTask(0, { dependsOn: ["1.2"] });
    const errors = check(plan);
    expect(messagesAt(errors, "tasks")[0]).toMatch(/dependency cycle: .*1\.1.*1\.2/);
  });

  test("a dependency on a task that does not exist", () => {
    expect(messagesAt(check(withTask(1, { dependsOn: ["9.9"] })), "tasks[1].dependsOn[0]")).toEqual(["depends on unknown task 9.9"]);
  });

  test("duplicate task identifiers", () => {
    expect(messagesAt(check(withTask(1, { id: "1.1" })), "tasks[1].id")).toEqual(["duplicates task 1.1"]);
  });

  test("a requirement with no scenario", () => {
    const plan = samplePlan();
    plan.requirements[0]!.scenarios = [];
    expect(messagesAt(check(plan), "requirements[0].scenarios")).toEqual(['requirement "The toolbar filters items" has no scenario']);
  });

  test("a removal needs a migration and a rename needs its previous name", () => {
    const plan = samplePlan();
    plan.capabilities.modified.push("legacy");
    plan.requirements.push(
      { capability: "legacy", name: "Old behavior", kind: "REMOVED", text: "No longer needed." },
      { capability: "legacy", name: "New name", kind: "RENAMED", text: "Renamed." },
    );
    const errors = check(plan);
    expect(messagesAt(errors, "requirements[1].migration")).toEqual(["a removed requirement needs a migration"]);
    expect(messagesAt(errors, "requirements[2].renamedFrom")).toEqual(["a renamed requirement needs its previous name"]);
  });

  test("a requirement's capability must be declared", () => {
    const plan = samplePlan({ capabilities: { new: [], modified: [] } });
    expect(messagesAt(check(plan), "requirements[0].capability")).toEqual(['capability "toolbar-search" is not listed under capabilities']);
  });

  test("scopes must be repository-relative and stay inside the repository", () => {
    const errors = check(withTask(0, { writes: ["/etc/passwd", "../outside.ts", "src/ok.ts"], reads: ["C:/Windows/system.ini"] }));
    expect(messagesAt(errors, "tasks[0].writes[0]")).toEqual(['scope "/etc/passwd" must be repository-relative']);
    expect(messagesAt(errors, "tasks[0].writes[1]")).toEqual(['scope "../outside.ts" escapes the repository root']);
    expect(messagesAt(errors, "tasks[0].reads[0]")).toEqual(['scope "C:/Windows/system.ini" must be repository-relative']);
    expect(messagesAt(errors, "tasks[0].writes[2]")).toEqual([]);
  });

  test("tasks that share a number must share a group", () => {
    expect(messagesAt(check(withTask(1, { group: "Docs" })), "tasks[1].group")[0]).toContain('must share one group');
  });

  test("a manual task needs its manual block", () => {
    expect(messagesAt(check(withTask(1, { role: "manual" })), "tasks[1].manual")).toEqual(["is required when role is manual"]);
  });

  test("every problem is reported in one pass", () => {
    const plan = withTask(0, { verify: ["cargo test"], requirements: [{ capability: "toolbar-search", name: "Nope" }] });
    plan.requirements[0]!.scenarios = [];
    expect(check(plan).length).toBeGreaterThanOrEqual(3);
  });
});
