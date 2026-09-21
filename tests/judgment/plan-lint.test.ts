import { describe, expect, test } from "bun:test";
import { validateAgainstOwnReferences } from "../../src/execution/load-tasks.ts";
import { judgmentCatalog, validateCatalog } from "../../src/judgment/catalog.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { validateDecision } from "../../src/judgment/decision.ts";
import {
  planLintAssessment,
  planLintDecision,
  planLintState,
  presentPlanLintFindings,
  PLAN_LINT_MAX_TASKS,
  renderPlanLintFinding,
} from "../../src/judgment/decisions/plan-lint.ts";
import { PLAN_LINT_COVERAGE_QUESTION_ID, planLintQuestionId } from "../../src/judgment/questions.ts";
import { loadQuestions } from "../../src/prompts/questions.ts";
import { renderArtifacts } from "../../src/planning/render.ts";
import { parseSpecRequirements } from "../../src/review/plan-lint.ts";
import { buildPlanLintInput, PLAN_LINT_SUMMARY_BYTES } from "../../src/review/plan-lint-input.ts";
import { samplePlan } from "../planning/sample-plan.ts";

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const size = (score: number, confidence: number) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 },
  confidence,
});

/** A clean answer for `count` tasks: good-yes questions high, good-no questions low, size small. */
function clean(count: number, overrides: JudgmentAnswers = {}): JudgmentAnswers {
  const answers: Record<string, JudgmentAnswers[string]> = { [PLAN_LINT_COVERAGE_QUESTION_ID]: noul(0.95) };
  for (let index = 1; index <= count; index += 1) {
    answers[planLintQuestionId(index, "verification")] = noul(0.95);
    answers[planLintQuestionId(index, "scope")] = noul(0.95);
    answers[planLintQuestionId(index, "atomicity")] = noul(0.95);
    answers[planLintQuestionId(index, "dependencies")] = noul(0.05);
    answers[planLintQuestionId(index, "size")] = size(0.5, 0.9);
  }
  return { ...answers, ...overrides };
}

describe("plan.lint decision", () => {
  test("is registered, valid, and declares its effects", () => {
    expect(judgmentCatalog).toContain(planLintDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
    expect(planLintDecision.effects).toEqual(["adds_advice", "reduces_work"]);
    expect(planLintDecision.id).toBe("plan.lint");
  });

  test("asks five questions per task and one over the list, with the wording the task-quality check had", () => {
    expect(Object.keys(validateDecision(planLintDecision))).toEqual([
      "task_1_verification", "task_1_scope", "task_1_atomicity", "task_1_dependencies", "task_1_size",
      "task_2_verification", "task_2_scope", "task_2_atomicity", "task_2_dependencies", "task_2_size",
      "coverage",
    ]);
    const wording = loadQuestions("plan.lint", { tasks: [{}] });
    const byId = Object.fromEntries(wording) as Record<string, { instructions: string }>;
    expect(byId.task_1_verification!.instructions).toMatch(/would the verification commands[^.]*fail if the task were implemented incorrectly/i);
    expect(byId.task_1_dependencies!.instructions).toMatch(/not among the task identifiers in its own dependencies list/i);
    for (const count of [1, 12, 40]) expect(loadQuestions("plan.lint", { tasks: Array.from({ length: count }, () => ({})) })).toHaveLength(count * 5 + 1);
  });

  test("a clean, confident answer acts with no findings and nothing uncertain", () => {
    expect(planLintDecision.gate(clean(2))).toEqual({ act: true, value: { findings: [], uncertain: [] } });
  });

  test("a confident finding per kind", () => {
    const cases: ["verification" | "scope" | "atomicity" | "dependencies" | "size" | "coverage", JudgmentAnswers][] = [
      ["verification", { [planLintQuestionId(1, "verification")]: noul(0.1) }],
      ["scope", { [planLintQuestionId(1, "scope")]: noul(0.1) }],
      ["atomicity", { [planLintQuestionId(1, "atomicity")]: noul(0.1) }],
      ["dependencies", { [planLintQuestionId(1, "dependencies")]: noul(0.9) }],
      ["size", { [planLintQuestionId(1, "size")]: size(2.8, 0.9) }],
      ["coverage", { [PLAN_LINT_COVERAGE_QUESTION_ID]: noul(0.1) }],
    ];
    for (const [kind, overrides] of cases) {
      const { findings, uncertain } = planLintAssessment(clean(1, overrides));
      expect(findings.map((finding) => finding.kind), kind).toEqual([kind]);
      expect(uncertain, kind).toEqual([]);
    }
  });

  test("an answer between the bands is uncertain, not a finding", () => {
    const { findings, uncertain } = planLintAssessment(clean(2, {
      [planLintQuestionId(2, "scope")]: noul(0.5),
      [PLAN_LINT_COVERAGE_QUESTION_ID]: noul(0.5),
      [planLintQuestionId(1, "size")]: size(3, 0.5),
    }));
    expect(findings).toEqual([]);
    expect(uncertain).toEqual([
      { kind: "size", index: 1 },
      { kind: "scope", index: 2 },
      { kind: "coverage", index: null },
    ]);
  });

  test("the bands are strict: the edges themselves are uncertain", () => {
    const { findings, uncertain } = planLintAssessment(clean(1, {
      [planLintQuestionId(1, "verification")]: noul(0.3),
      [planLintQuestionId(1, "dependencies")]: noul(0.7),
    }));
    expect(findings).toEqual([]);
    expect(uncertain.map(({ kind }) => kind).sort()).toEqual(["dependencies", "verification"]);
  });

  test("a missing or non-finite answer is uncertain, and no answers at all abstain", () => {
    expect(planLintAssessment(clean(1, { [planLintQuestionId(1, "scope")]: noul(Number.NaN) })).uncertain).toEqual([{ kind: "scope", index: 1 }]);
    expect(planLintDecision.gate({})).toEqual({ act: false, reason: "no concern was answered" });
  });

  test("a finding is a template naming the task, never model text", () => {
    const { findings } = planLintAssessment(clean(2, { [planLintQuestionId(2, "scope")]: noul(0.1) }));
    expect(renderPlanLintFinding(findings[0]!, ["1.1", "1.2"])).toBe(
      "Task 1.2: its write scopes may not cover every file its description requires changing (probability 0.90).",
    );
    expect(renderPlanLintFinding({ kind: "coverage", index: null, probability: 0.9 }, [])).toBe(
      "The tasks together may not cover every requirement (probability 0.90).",
    );
    expect(renderPlanLintFinding({ kind: "scope", index: 9, probability: 0.9 }, ["1.1"])).toBeNull();
  });

  test("findings are listed highest probability first, capped, with the total", () => {
    const answers = clean(12, Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
      [planLintQuestionId(index + 1, "scope"), noul(0.05 + index * 0.01)])));
    const presented = presentPlanLintFindings(planLintAssessment(answers).findings, Array.from({ length: 12 }, (_, index) => `1.${index + 1}`));
    expect(presented.total).toBe(12);
    expect(presented.lines).toHaveLength(8);
    expect(presented.lines[0]).toContain("Task 1.1:");
  });

  test("the state is the summary, the requirements and the tasks", () => {
    const state = planLintState(planLintDecision.representativeInput) as { summary: string; requirements: unknown[]; tasks: { index: number; scopes: unknown }[] };
    expect(Object.keys(state).sort()).toEqual(["requirements", "summary", "tasks"]);
    expect(state.tasks.map(({ index }) => index)).toEqual([1, 2]);
  });
});

describe("buildPlanLintInput", () => {
  function artifacts(plan = samplePlan()) {
    const rendered = Object.fromEntries(renderArtifacts(plan, "/change").map((artifact) => [artifact.path.replace("/change/", ""), artifact.content]));
    return {
      proposalText: rendered["proposal.md"]!,
      requirements: Object.entries(rendered).filter(([path]) => path.startsWith("specs/")).flatMap(([path, content]) => parseSpecRequirements(path.split("/")[1]!, content)),
      document: validateAgainstOwnReferences(rendered["tasks.md"]!, "tasks.md"),
    };
  }

  test("builds the state with every requirement and scenario name kept", () => {
    const built = buildPlanLintInput(artifacts());
    expect(built.ok).toBeTrue();
    if (!built.ok) return;
    expect(built.taskIds).toEqual(["1.1", "1.2"]);
    expect(built.input.requirements.map(({ name }) => name)).toEqual(["The toolbar filters items"]);
    expect(built.input.requirements[0]!.scenarios.map(({ name }) => name)).toEqual(["Typing filters the list", "Clearing the box restores the list"]);
    expect(built.input.tasks[1]).toMatchObject({ id: "1.2", dependsOn: ["1.1"], writes: ["docs/toolbar.md"], verify: ["bun run docs:check"] });
  });

  test("the summary is an excerpt of the proposal of at most 2,000 bytes", () => {
    const input = artifacts();
    const built = buildPlanLintInput({ ...input, proposalText: `# Proposal\n\n${"very long text ".repeat(500)}` });
    expect(built.ok && Buffer.byteLength(built.input.summary, "utf8")).toBeLessThanOrEqual(PLAN_LINT_SUMMARY_BYTES + 100);
  });

  test("requirement text is excerpted to fit while names stay", () => {
    const input = artifacts();
    const huge = input.requirements.map((requirement) => ({
      ...requirement,
      text: "x".repeat(50_000),
      scenarios: requirement.scenarios.map((scenario) => ({ ...scenario, text: "y".repeat(50_000) })),
    }));
    const built = buildPlanLintInput({ ...input, requirements: huge });
    expect(built.ok).toBeTrue();
    if (!built.ok) return;
    expect(built.input.requirements[0]!.name).toBe("The toolbar filters items");
    expect(built.input.requirements[0]!.text.length).toBeLessThan(2_000);
  });

  test("more than 40 tasks are not asked about", () => {
    const input = artifacts();
    const many = { ...input.document, tasks: Array.from({ length: PLAN_LINT_MAX_TASKS + 1 }, () => input.document.tasks[0]!) };
    expect(buildPlanLintInput({ ...input, document: many })).toEqual({ ok: false, reason: "too_many_tasks" });
    expect(buildPlanLintInput({ ...input, document: { ...input.document, tasks: [] } })).toEqual({ ok: false, reason: "no_tasks" });
  });
});
