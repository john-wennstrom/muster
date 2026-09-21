import { LANE_POLICY, type Lane } from "../controller/lane.ts";
import { renderPrompt, type RenderedPrompt } from "../prompts/render.ts";
import { describePlanSchema } from "./plan-schema.ts";

/** The prompts a planning run sends, assembled from templates; nothing here is wording. */

export interface PlanningAnalysis {
  readonly model: string;
  readonly content: string;
}

export interface CurrentArtifact {
  readonly path: string;
  readonly content: string;
}

export interface PlanningPromptInput {
  readonly changeName: string;
  /** The request as the user typed it. */
  readonly request: string;
  readonly lane: Lane;
  readonly authoritativeContext: unknown;
  /** Refinement: the change's artifacts as they stand. */
  readonly currentArtifacts?: readonly CurrentArtifact[];
  /** Refinement after a revising review: the review's required changes, already rendered. */
  readonly requiredChanges?: string;
  /** Opinions and a debate, when the lane ran them. */
  readonly priorAnalysis?: readonly PlanningAnalysis[];
  /** The validation failures of a previous attempt, as a list. */
  readonly validationFailures?: string;
  /** Triage confidently judged the change should proceed, so the session returns a plan. */
  readonly triageProceeds?: boolean;
}

const json = (value: unknown): string => JSON.stringify(value);

function currentArtifactsBlock(artifacts: readonly CurrentArtifact[] | undefined): string {
  if (!artifacts || artifacts.length === 0) return "";
  return renderPrompt("planning-current-artifacts", {
    ARTIFACTS: artifacts.map(({ path, content }) => renderPrompt("planning-artifact", { PATH: path, CONTENT: content })).join("\n\n"),
  });
}

function priorAnalysisBlock(analysis: readonly PlanningAnalysis[] | undefined): string {
  if (!analysis || analysis.length === 0) return "";
  return renderPrompt("planning-prior-analysis", {
    RESULTS: analysis.map((result, index) =>
      renderPrompt("planning-prior-result", { POSITION: String(index + 1), MODEL: result.model, CONTENT: result.content })).join("\n\n"),
  });
}

/** The prompt of the session that returns the plan. */
export function renderPlanPrompt(input: PlanningPromptInput): RenderedPrompt {
  return renderPrompt("planning-plan", {
    CHANGE_NAME: input.changeName,
    USER_REQUEST: input.request,
    LANE_GUIDANCE: renderPrompt(`planning-guidance-${input.lane}`),
    LANE_TASK_LIMIT: String(LANE_POLICY[input.lane].maxTasks),
    AUTHORITATIVE_CONTEXT: json(input.authoritativeContext),
    DISPOSITION_NOTE: input.triageProceeds ? renderPrompt("planning-triage-note") : "",
    CURRENT_ARTIFACTS: currentArtifactsBlock(input.currentArtifacts),
    REQUIRED_CHANGES: input.requiredChanges ?? "",
    PRIOR_ANALYSIS: priorAnalysisBlock(input.priorAnalysis),
    PLAN_SCHEMA: describePlanSchema(),
    VALIDATION_FAILURES: input.validationFailures
      ? renderPrompt("planning-validation-failures", { FAILURES: input.validationFailures })
      : "",
  });
}

/** One specialist's analysis, for a large change. */
export function renderOpinionPrompt(input: PlanningPromptInput): RenderedPrompt {
  return renderPrompt("planning-opinion", {
    CHANGE_NAME: input.changeName,
    USER_REQUEST: input.request,
    AUTHORITATIVE_CONTEXT: json(input.authoritativeContext),
    CURRENT_ARTIFACTS: currentArtifactsBlock(input.currentArtifacts),
    REQUIRED_CHANGES: input.requiredChanges ?? "",
  });
}

/** The debate over the specialists' opinions, for a large change. */
export function renderDebatePrompt(input: PlanningPromptInput): RenderedPrompt {
  return renderPrompt("planning-debate", {
    CHANGE_NAME: input.changeName,
    USER_REQUEST: input.request,
    AUTHORITATIVE_CONTEXT: json(input.authoritativeContext),
    PRIOR_ANALYSIS: priorAnalysisBlock(input.priorAnalysis),
  });
}

/** What a revising review asked for, as the text folded into the request and the plan prompt. */
export function renderRequiredChanges(review: {
  readonly round: number;
  readonly requiredChanges: readonly string[];
  readonly criticalFindings: readonly string[];
}): string {
  return renderPrompt("planning-required-changes", {
    ROUND: String(review.round),
    REQUIRED_CHANGES: review.requiredChanges.map((change) => `- ${change}`).join("\n"),
    CRITICAL_FINDINGS_BLOCK: review.criticalFindings.length > 0
      ? renderPrompt("planning-critical-findings", { FINDINGS: review.criticalFindings.map((finding) => `- ${finding}`).join("\n") })
      : "",
  });
}
