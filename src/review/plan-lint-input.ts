import { truncateBytes } from "../context/candidates.ts";
import type { ValidatedTaskDocument } from "../execution/task-schema.ts";
import {
  planLintState,
  PLAN_LINT_MAX_TASKS,
  type PlanLintInput,
  type PlanLintRequirementInput,
} from "../judgment/decisions/plan-lint.ts";
import type { SpecRequirement } from "./plan-lint.ts";

/** The most of the proposal a plan.lint state carries. */
export const PLAN_LINT_SUMMARY_BYTES = 2_000;
/** The state's target size, under the service's limit so questions and escaping fit beside it. */
const STATE_TARGET_BYTES = 80_000;
const MAX_TEXT_EXCERPT_BYTES = 800;

export type PlanLintStateResult =
  | {
      readonly ok: true;
      readonly input: PlanLintInput;
      /** In state order, so a finding's one-based index names `taskIds[index - 1]`. */
      readonly taskIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: "no_tasks" | "too_many_tasks" };

/**
 * Turns a change's linted artifacts into the semantic check's state: an excerpt of the proposal,
 * the requirement and scenario text excerpted to fit, and each task's description, dependencies,
 * scopes and verification commands. A list over 40 tasks is not asked about. Requirement and
 * scenario names are always kept; only their text is excerpted, to what the size target leaves.
 */
export function buildPlanLintInput(input: {
  readonly proposalText: string;
  readonly requirements: readonly SpecRequirement[];
  readonly document: ValidatedTaskDocument;
}): PlanLintStateResult {
  const tasks = input.document.tasks.map((task) => ({
    id: task.id,
    description: task.description,
    dependsOn: task.dependsOn,
    reads: task.reads,
    writes: task.writes,
    verify: task.verify,
  }));
  if (tasks.length === 0) return { ok: false, reason: "no_tasks" };
  if (tasks.length > PLAN_LINT_MAX_TASKS) return { ok: false, reason: "too_many_tasks" };

  const summary = truncateBytes(input.proposalText.trim(), PLAN_LINT_SUMMARY_BYTES);
  const withText = (excerpt: (text: string) => string): PlanLintRequirementInput[] =>
    input.requirements.map((requirement) => ({
      name: requirement.name,
      text: excerpt(requirement.text),
      scenarios: requirement.scenarios.map((scenario) => ({ name: scenario.name, text: excerpt(scenario.text) })),
    }));

  const itemCount = input.requirements.reduce((sum, requirement) => sum + 1 + requirement.scenarios.length, 0);
  const namesOnly = { summary, requirements: withText(() => ""), tasks };
  const remaining = STATE_TARGET_BYTES - Buffer.byteLength(JSON.stringify(planLintState(namesOnly)), "utf8");
  const perItem = itemCount === 0 || remaining <= 0 ? 0 : Math.min(MAX_TEXT_EXCERPT_BYTES, Math.floor(remaining / itemCount));
  const excerpt = (text: string): string => {
    if (perItem === 0) return "";
    const kept = truncateBytes(text, perItem);
    return kept.length < text.length ? `${kept}…` : kept;
  };
  return { ok: true, input: { summary, requirements: withText(excerpt), tasks }, taskIds: tasks.map((task) => task.id) };
}
