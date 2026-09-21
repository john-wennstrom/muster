import { createHash } from "node:crypto";
import { HarnessError } from "../shared/errors.ts";
import type { JudgmentQuestion, JudgmentQuestions } from "./client.ts";

/**
 * Question helpers and validation. Question wording for each decision also lives in this
 * file, one reviewable place: the service reads questions literally, so a wording change is
 * reviewed like a prompt change, and negation and scoping belong in the wording, not in a
 * comment. Each decision's questions are appended here by the change that adds the decision.
 */

export type QuestionEntry = readonly [id: string, question: JudgmentQuestion];

export function noul(
  instructions: string,
  criteria?: { readonly true?: string; readonly false?: string },
): JudgmentQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export function choice(
  instructions: string,
  criteria: Readonly<Record<string, string | null>>,
): JudgmentQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: string, criteria: readonly string[]): JudgmentQuestion {
  return { type: "score", instructions, criteria };
}

function invalid(decision: string, question: string | null, message: string): never {
  throw new HarnessError(
    "JUDGMENT_QUESTION_INVALID",
    `Judgment decision ${decision}${question === null ? "" : `, question ${question}`}: ${message}`,
    { decision, question },
  );
}

/**
 * Rejects a malformed definition as a programming error naming the decision and question.
 * Takes entries rather than a map so a duplicate identifier is representable, and so caught.
 */
export function validateQuestions(
  decision: string,
  entries: readonly QuestionEntry[],
): JudgmentQuestions {
  if (entries.length === 0) invalid(decision, null, "defines no questions");
  const questions: Record<string, JudgmentQuestion> = {};
  for (const [id, question] of entries) {
    if (!id.trim()) invalid(decision, id, "has an empty identifier");
    if (Object.hasOwn(questions, id)) invalid(decision, id, "duplicates a question identifier");
    const type: unknown = question?.type;
    if (type !== "noul" && type !== "choice" && type !== "score") {
      invalid(decision, id, `has unsupported type ${String(type)}`);
    }
    if (typeof question.instructions !== "string" || !question.instructions.trim()) {
      invalid(decision, id, "has empty instructions");
    }
    if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length === 0) invalid(decision, id, "is a choice without options");
      if (options.some((option) => !option.trim())) invalid(decision, id, "has an empty option name");
    }
    if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
        invalid(decision, id, "is a rubric without criteria");
      }
      if (question.criteria.some((level) => typeof level !== "string" || !level.trim())) {
        invalid(decision, id, "has an empty rubric criterion");
      }
    }
    questions[id] = question;
  }
  return questions;
}

/** Content hash of a decision's questions, so wording changes are visible and reviewable. */
export function questionsFingerprint(questions: JudgmentQuestions): string {
  return createHash("sha256").update(canonicalize(questions)).digest("hex");
}

/** Key-order-independent JSON, shared with fixture keys so equal content hashes equally. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * change.triage: the request's disposition, the four risk questions, whether the change is
 * mechanical and how far it reaches, and two questions per candidate file that code retrieved.
 * One request replaces the two it merges. The wording is the wording of the questions it took
 * over, so a file that merely shares names with the request is no evidence of anything.
 */
export const TRIAGE_QUESTION_IDS = {
  disposition: "disposition",
  publicContract: "public_contract",
  dataMigration: "data_migration",
  securityBoundary: "security_boundary",
  designAmbiguity: "design_ambiguity",
  mechanical: "mechanical",
  reach: "reach",
} as const;

export const TRIAGE_DISPOSITIONS = ["proceed", "needs_clarification", "already_satisfied"] as const;
export type TriageDisposition = (typeof TRIAGE_DISPOSITIONS)[number];

export type TriageCandidateQuestionKind = "implements" | "needs_change";

export function triageCandidateQuestionId(index: number, kind: TriageCandidateQuestionKind): string {
  return `candidate_${index}_${kind}`;
}

/** The index and kind a per-candidate question identifier names, or null for any other identifier. */
export function parseTriageCandidateQuestionId(
  id: string,
): { readonly index: number; readonly kind: TriageCandidateQuestionKind } | null {
  const match = /^candidate_(\d+)_(implements|needs_change)$/.exec(id);
  return match ? { index: Number(match[1]), kind: match[2] as TriageCandidateQuestionKind } : null;
}

/**
 * review.task_focus: where a task's code reviewer should look first. Six yes/no questions over
 * the review inputs and one rubric on impact outside the diff. Each question states its own
 * boundary because the service reads literally. The first four are worded so that a good
 * change answers yes, and the last two so that a good change answers no; the gate's
 * thresholds depend on that direction.
 */
export const TASK_FOCUS_QUESTION_IDS = {
  scopeContainment: "scope_containment",
  contractMatch: "contract_match",
  scenarioCoverage: "scenario_coverage",
  testFirstConsistency: "test_first_consistency",
  stubOrHardcoded: "stub_or_hardcoded",
  securityBoundary: "security_boundary",
  reach: "reach",
} as const;

export const TASK_FOCUS_REACH_LEVELS = ["none", "callers", "modules", "external"] as const;

/**
 * command.classification: which manual-approval category, if any, a host command belongs to.
 * The category is one choice, with each option defined by what the command does to state that
 * cannot be taken back or that lies beyond this machine, because a bare "is this dangerous?"
 * answers yes to anything with a scary name. The state is only the command line, so the
 * wording tells the service to judge what the command line plainly does and to answer none
 * when it names no effect. The three yes/no questions are recorded with the call and never
 * gated, so calibration can show where they and the category disagree.
 */
export const COMMAND_QUESTION_IDS = {
  category: "category",
  irreversible: "irreversible",
  remoteMutation: "remote_mutation",
  credentialUse: "credential_use",
} as const;

export const COMMAND_CATEGORIES = [
  "none",
  "authentication",
  "elevated_permission",
  "destructive",
  "external_side_effect",
] as const;
export type CommandCategoryChoice = (typeof COMMAND_CATEGORIES)[number];

/**
 * review.extraction: what a planning reviewer's prose response amounts to as a review. One
 * choice gives the verdict the response as a whole reaches, and one choice per candidate line
 * says how that line functions. Every option is defined by whether the line or the response
 * raises a problem that blocks the plan, because the service reads literally: praise, a
 * restatement of the task, and a description of what the reviewer read raise nothing, and a
 * line that only suggests an improvement is not a blocking problem however strongly it is
 * worded. The service classifies lines it is shown and writes none.
 */
export const REVIEW_EXTRACTION_QUESTION_IDS = {
  verdict: "verdict",
} as const;

export const REVIEW_EXTRACTION_VERDICTS = ["approve", "revise", "unclear"] as const;
export type ReviewExtractionVerdictChoice = (typeof REVIEW_EXTRACTION_VERDICTS)[number];

export const REVIEW_EXTRACTION_LINE_KINDS = [
  "critical",
  "required",
  "recommendation",
  "not_a_finding",
] as const;
export type ReviewExtractionLineKind = (typeof REVIEW_EXTRACTION_LINE_KINDS)[number];

export function reviewExtractionLineQuestionId(index: number): string {
  return `line_${index}_kind`;
}

/** The index a per-line question identifier names, or null for any other identifier. */
export function parseReviewExtractionLineQuestionId(id: string): number | null {
  const match = /^line_(\d+)_kind$/.exec(id);
  return match ? Number(match[1]) : null;
}

/**
 * plan.lint: whether a plan's task list is a good one, judged from the text of
 * the tasks and of the requirements and scenarios they implement. Five questions per task and
 * one over the list. Each states its own boundary because the service reads literally, and each
 * asks about a property of the text, never about the code the task will produce. Verification,
 * scope, and atomicity are worded so that a good task answers yes; dependencies is worded so
 * that a good task answers no; the gate's thresholds depend on those directions.
 */
export const PLAN_LINT_KINDS = [
  "verification",
  "scope",
  "atomicity",
  "dependencies",
  "size",
  "coverage",
] as const;
export type PlanLintKind = (typeof PLAN_LINT_KINDS)[number];

export const PLAN_LINT_COVERAGE_QUESTION_ID = "coverage";
export const PLAN_LINT_SIZE_LEVELS = ["single", "small", "large", "oversized"] as const;

export function planLintQuestionId(index: number, kind: Exclude<PlanLintKind, "coverage">): string {
  return `task_${index}_${kind}`;
}

/** The index and kind a per-task question identifier names, or null for any other identifier. */
export function parsePlanLintQuestionId(
  id: string,
): { readonly index: number; readonly kind: Exclude<PlanLintKind, "coverage"> } | null {
  const match = /^task_(\d+)_(verification|scope|atomicity|dependencies|size)$/.exec(id);
  return match
    ? { index: Number(match[1]), kind: match[2] as Exclude<PlanLintKind, "coverage"> }
    : null;
}

/**
 * task.recovery: what to do after a task attempt failed. The state holds the task's definition,
 * the change's lane, and the failure (its evidence, reproduction and stated fix). One choice
 * decides; the yes/no answer is recorded so calibration can show where it and the choice disagree.
 */
export const TASK_RECOVERY_QUESTION_IDS = {
  nextStep: "next_step",
  humanNeeded: "human_needed",
} as const;

export const TASK_RECOVERY_ACTIONS = ["retry", "escalate", "stop"] as const;

/**
 * review.triage: whether an edit to a planning review's proposal or design, made after the
 * review approved, changes anything that approval depended on. The state holds the unified
 * diffs of the two files and the approving review's recommendations, so each question is about
 * the change and never about the whole document. Each states its own boundary because the
 * service reads literally, and each asks about substance rather than the size of the diff: a
 * long diff of rewording and a one-line diff that reverses a decision are both possible.
 */
export const REVIEW_TRIAGE_QUESTION_IDS = {
  materiality: "materiality",
  requirements: "changes_requirements",
  scenarios: "changes_scenarios",
  tasks: "changes_tasks",
  scopes: "changes_scopes",
  contradicts: "contradicts_approval",
} as const;

/** The four materiality levels, in the order their scores count from zero. */
export const REVIEW_TRIAGE_MATERIALITY_LEVELS = [
  "wording",
  "clarification",
  "substantive",
  "scope_or_design",
] as const;

/** The yes/no questions, every one of which must be confidently no for an edit to be skipped. */
export const REVIEW_TRIAGE_CHANGE_QUESTION_IDS = [
  REVIEW_TRIAGE_QUESTION_IDS.requirements,
  REVIEW_TRIAGE_QUESTION_IDS.scenarios,
  REVIEW_TRIAGE_QUESTION_IDS.tasks,
  REVIEW_TRIAGE_QUESTION_IDS.scopes,
  REVIEW_TRIAGE_QUESTION_IDS.contradicts,
] as const;

/**
 * routing.task_model: whether one builder task can be carried out by a cheaper model. The state
 * is only the task's contract, so every question is about what the contract asks for, and each
 * states its own boundary because the service reads literally. The first is worded so that a
 * routable task answers yes, and the other five so that a routable task answers no; the gate's
 * thresholds depend on that direction. A bare "is this task hard?" would answer yes to anything
 * long, so difficulty is split into the specific things that make a cheaper model unsafe.
 */
export const TASK_ROUTING_QUESTION_IDS = {
  mechanical: "mechanical",
  deepReasoning: "needs_deep_reasoning",
  largeContext: "needs_large_context",
  novelDesign: "needs_novel_design",
  securityBoundary: "changes_security_boundary",
  publicContract: "changes_public_contract",
  reach: "reach",
} as const;

/** The yes/no questions a routable task answers no to, every one of which must be confidently no. */
export const TASK_ROUTING_RISK_QUESTION_IDS = [
  TASK_ROUTING_QUESTION_IDS.deepReasoning,
  TASK_ROUTING_QUESTION_IDS.largeContext,
  TASK_ROUTING_QUESTION_IDS.novelDesign,
  TASK_ROUTING_QUESTION_IDS.securityBoundary,
  TASK_ROUTING_QUESTION_IDS.publicContract,
] as const;

export const TASK_ROUTING_REACH_LEVELS = ["contained", "neighbouring", "cross_module", "system_wide"] as const;

