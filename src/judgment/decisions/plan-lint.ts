import type { JsonValue, JudgmentAnswers } from "../client.ts";
import { act, abstain, defineDecision, noulOf, scoreOf } from "../decision.ts";
import { PLAN_LINT_COVERAGE_QUESTION_ID, PLAN_LINT_KINDS, parsePlanLintQuestionId, type PlanLintKind } from "../questions.ts";
import { loadQuestions } from "../../prompts/questions.ts";

/**
 * plan.lint: the semantic half of plan review, asked once per `/change review` over the task list
 * and the requirement text. It answers the six task-quality concerns: verification, scope,
 * atomicity, dependencies, size and coverage. A question whose good answer is yes speaks below
 * `PLAN_LINT_BANDS.no`, and one whose good answer is no speaks above `PLAN_LINT_BANDS.yes`; the
 * size rubric speaks at `PLAN_LINT_SIZE_AT` with at least `PLAN_LINT_SIZE_CONFIDENCE`; coverage
 * speaks like a good-yes question. A concern that is neither confidently clean nor a finding is
 * uncertain, and the small lane treats it as a reason to escalate. A finding is a kind, a task,
 * and a probability; its text is a fixed template filled in by code, so nothing a model wrote
 * reaches a person or a reviewer. The thresholds are starting points for calibration.
 */
export const PLAN_LINT_BANDS = { yes: 0.7, no: 0.3 } as const;
export const PLAN_LINT_SIZE_AT = 2.5;
export const PLAN_LINT_SIZE_CONFIDENCE = 0.7;
/** Findings a notes list shows, highest probability first; the total is always stated. */
export const PLAN_LINT_MAX_DISPLAYED = 8;
/** More tasks than this are not asked about: the question count and the state would outgrow the service. */
export const PLAN_LINT_MAX_TASKS = 40;

export interface PlanLintTaskInput {
  readonly id: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly verify: readonly string[];
}

export interface PlanLintScenarioInput {
  readonly name: string;
  readonly text: string;
}

export interface PlanLintRequirementInput {
  readonly name: string;
  readonly text: string;
  readonly scenarios: readonly PlanLintScenarioInput[];
}

export interface PlanLintInput {
  /** At most 2,000 bytes from the start of the proposal. */
  readonly summary: string;
  /** Every requirement and scenario name, with excerpted text. */
  readonly requirements: readonly PlanLintRequirementInput[];
  /** In document order; at most 40. */
  readonly tasks: readonly PlanLintTaskInput[];
}

/** The state sent for the call: exactly the summary excerpt, the requirements, and the tasks. */
export function planLintState(input: PlanLintInput): JsonValue {
  return {
    summary: input.summary,
    requirements: input.requirements.map((requirement) => ({
      name: requirement.name,
      text: requirement.text,
      scenarios: requirement.scenarios.map(({ name, text }) => ({ name, text })),
    })),
    tasks: input.tasks.map((task, position) => ({
      index: position + 1,
      id: task.id,
      description: task.description,
      dependsOn: [...task.dependsOn],
      scopes: { reads: [...task.reads], writes: [...task.writes] },
      verify: [...task.verify],
    })),
  };
}

export interface PlanLintFinding {
  readonly kind: PlanLintKind;
  /** One-based, matching the task's index in the state; null for the whole-list coverage finding. */
  readonly index: number | null;
  /** The probability that the defect is present; for size, the confidence of the rubric answer. */
  readonly probability: number;
  /** The rubric score, for a size finding only. */
  readonly score?: number;
}

/** Rounded so a threshold comparison and a rendered probability never show float noise. */
const complement = (value: number): number => Math.round((1 - value) * 1e6) / 1e6;

const GOOD_ANSWER_YES: ReadonlySet<PlanLintKind> = new Set(["verification", "scope", "atomicity", "coverage"]);

/** Where one concern's answer falls: a finding, confidently clean, or neither. */
type Verdict = { readonly finding: number } | "clean" | "uncertain";

function noulVerdict(kind: PlanLintKind, value: number | null): Verdict {
  if (value === null || !Number.isFinite(value)) return "uncertain";
  if (GOOD_ANSWER_YES.has(kind)) {
    if (value < PLAN_LINT_BANDS.no) return { finding: complement(value) };
    return value > PLAN_LINT_BANDS.yes ? "clean" : "uncertain";
  }
  if (value > PLAN_LINT_BANDS.yes) return { finding: value };
  return value < PLAN_LINT_BANDS.no ? "clean" : "uncertain";
}

export interface PlanLintConcern {
  readonly kind: PlanLintKind;
  /** One-based, matching the task's index in the state; null for the whole-list coverage concern. */
  readonly index: number | null;
}

/** What the answers say: every finding they support, and every concern they leave uncertain. */
export function planLintAssessment(answers: JudgmentAnswers): {
  findings: PlanLintFinding[];
  uncertain: PlanLintConcern[];
  answered: number;
} {
  const findings: PlanLintFinding[] = [];
  const uncertain: PlanLintConcern[] = [];
  let answered = 0;
  const record = (concern: PlanLintConcern, verdict: Verdict, extra: { score?: number } = {}) => {
    answered += 1;
    if (verdict === "uncertain") uncertain.push(concern);
    else if (verdict !== "clean") findings.push({ ...concern, probability: verdict.finding, ...extra });
  };
  for (const id of Object.keys(answers)) {
    const parsed = parsePlanLintQuestionId(id);
    if (!parsed) continue;
    const concern = { kind: parsed.kind, index: parsed.index };
    if (parsed.kind === "size") {
      const size = scoreOf(answers, id);
      if (!size || !Number.isFinite(size.score) || !Number.isFinite(size.confidence) || size.confidence < PLAN_LINT_SIZE_CONFIDENCE) {
        record(concern, "uncertain");
      } else if (size.score >= PLAN_LINT_SIZE_AT) {
        record(concern, { finding: size.confidence }, { score: size.score });
      } else {
        record(concern, "clean");
      }
      continue;
    }
    record(concern, noulVerdict(parsed.kind, noulOf(answers, id)));
  }
  const byOrder = (left: PlanLintConcern, right: PlanLintConcern) =>
    (left.index ?? Infinity) - (right.index ?? Infinity) || PLAN_LINT_KINDS.indexOf(left.kind) - PLAN_LINT_KINDS.indexOf(right.kind);
  findings.sort(byOrder);
  uncertain.sort(byOrder);
  if (answers[PLAN_LINT_COVERAGE_QUESTION_ID] !== undefined) {
    const verdict = noulVerdict("coverage", noulOf(answers, PLAN_LINT_COVERAGE_QUESTION_ID));
    const concern = { kind: "coverage" as const, index: null };
    answered += 1;
    if (verdict === "uncertain") uncertain.push(concern);
    else if (verdict !== "clean") findings.push({ ...concern, probability: verdict.finding });
  }
  return { findings, uncertain, answered };
}

/** The only text a finding ever has: one fixed sentence per kind, filled with identifiers and numbers. */
const PLAN_LINT_TEMPLATES: Record<
  PlanLintKind,
  (fill: { readonly task: string; readonly probability: string; readonly score: string }) => string
> = {
  verification: ({ task, probability }) =>
    `Task ${task}: its verification commands may pass even if the task were implemented incorrectly (probability ${probability}).`,
  scope: ({ task, probability }) =>
    `Task ${task}: its write scopes may not cover every file its description requires changing (probability ${probability}).`,
  atomicity: ({ task, probability }) =>
    `Task ${task}: it may bundle more than one coherent unit of work (probability ${probability}).`,
  dependencies: ({ task, probability }) =>
    `Task ${task}: it may depend on work that is not among its listed dependencies (probability ${probability}).`,
  size: ({ task, probability, score }) =>
    `Task ${task}: it may be too large to verify as one unit (size ${score} of 3, probability ${probability}).`,
  coverage: ({ probability }) =>
    `The tasks together may not cover every requirement (probability ${probability}).`,
};

/** Renders one finding, or null when its task index names no task in `taskIds`. */
export function renderPlanLintFinding(finding: PlanLintFinding, taskIds: readonly string[]): string | null {
  const task = finding.index === null ? "" : taskIds[finding.index - 1];
  if (task === undefined) return null;
  return PLAN_LINT_TEMPLATES[finding.kind]({
    task,
    probability: finding.probability.toFixed(2),
    score: (finding.score ?? 0).toFixed(1),
  });
}

/** Rendered findings, highest probability first and capped, with the total that were produced. */
export function presentPlanLintFindings(
  findings: readonly PlanLintFinding[],
  taskIds: readonly string[],
  limit: number = PLAN_LINT_MAX_DISPLAYED,
): { readonly total: number; readonly lines: readonly string[] } {
  const rendered = findings
    .map((finding) => ({ finding, text: renderPlanLintFinding(finding, taskIds) }))
    .filter((entry): entry is { finding: PlanLintFinding; text: string } => entry.text !== null)
    .sort((left, right) => right.finding.probability - left.finding.probability);
  return { total: rendered.length, lines: rendered.slice(0, limit).map((entry) => entry.text) };
}

export interface PlanLintGateValue {
  readonly findings: readonly PlanLintFinding[];
  /** Concerns that were neither confidently clean nor a finding. */
  readonly uncertain: readonly PlanLintConcern[];
}

export const planLintDecision = defineDecision<PlanLintInput, PlanLintGateValue>({
  id: "plan.lint",
  version: 1,
  // Findings on the medium and large lanes are advice. On the small lane a clean answer approves
  // the plan without a reviewer, so acting can skip work, and every doubt escalates.
  effects: ["adds_advice", "reduces_work"],
  representativeInput: {
    summary: "Retry invoice parsing when the total is missing.",
    requirements: [{
      name: "A missing invoice total is retried once",
      text: "The parser SHALL retry once when invoice_total is missing.",
      scenarios: [{ name: "Missing total is retried", text: "WHEN the total is missing THEN one retry is made" }],
    }],
    tasks: [
      {
        id: "1.1",
        description: "Retry `parseInvoice` once when invoice_total is missing",
        dependsOn: [],
        reads: ["src/billing/**"],
        writes: ["src/billing/invoice.ts", "tests/billing/invoice.test.ts"],
        verify: ["bun test tests/billing/invoice.test.ts"],
      },
      {
        id: "1.2",
        description: "Document the retry in the billing guide",
        dependsOn: ["1.1"],
        reads: [],
        writes: ["docs/billing.md"],
        verify: ["bun run docs:check"],
      },
    ],
  },
  questions: (input) => loadQuestions("plan.lint", { tasks: input.tasks }),
  state: planLintState,
  gate: (answers) => {
    const { findings, uncertain, answered } = planLintAssessment(answers);
    return answered === 0 ? abstain("no concern was answered") : act({ findings, uncertain });
  },
});
