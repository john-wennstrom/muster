import type { SupplementalFact } from "../integrations/optional-adapters.ts";
import type {
  BudgetAmount,
  BudgetDecision,
  BudgetEvaluator,
} from "../telemetry/budget.ts";
import { HarnessError } from "../shared/errors.ts";
import {
  orchestrationPolicy,
  type ComplexityDecision,
  type OrchestrationPolicy,
} from "./complexity-router.ts";

export type PlanningPhase = "propose" | "refine";
export type PlanningAgentStage = "specialist_opinion" | "debate" | "synthesis";

export interface PlanningInput {
  changeName: string;
  prompt: string;
  complexity: ComplexityDecision;
  optionalBudgetAvailable: boolean;
  authoritativeContext?: Readonly<Record<string, unknown>>;
}

export interface PlanningAgentRequest {
  phase: PlanningPhase;
  stage: PlanningAgentStage;
  changeName: string;
  prompt: string;
  complexity: ComplexityDecision;
  policy: OrchestrationPolicy;
  authoritativeContext: Readonly<Record<string, unknown>>;
  supplementalFacts: readonly SupplementalFact[];
  priorResults: readonly PlanningAgentResult[];
  opinionIndex?: number;
}

export interface PlanningAgentResult {
  model: string;
  content: string;
}

export interface PlanningArtifactWriteRequest {
  phase: PlanningPhase;
  changeName: string;
  synthesis: PlanningAgentResult;
  opinions: readonly PlanningAgentResult[];
  debate?: PlanningAgentResult;
}

export interface PlanningDependencies {
  runAgent(request: PlanningAgentRequest): Promise<PlanningAgentResult>;
  writeArtifacts(request: PlanningArtifactWriteRequest): Promise<void>;
  readSupplementalContext?(query: string): Promise<readonly SupplementalFact[]>;
  specialistOpinionCount?: number;
  budget?: BudgetEvaluator;
  budgetEstimates?: Partial<Record<PlanningAgentStage, BudgetAmount>>;
  /**
   * Total synthesis attempts (1 = no retry) when `writeArtifacts` rejects the
   * synthesis output — e.g. a hand-escaped JSON bundle with one bad quote.
   * Re-running the whole `/change propose` is a full preflight + specialist
   * pass; feeding the exact parse/validation error back for one corrected
   * synthesis attempt is far cheaper and usually enough. Defaults to 2.
   */
  maxSynthesisAttempts?: number;
}

export interface PlanningResult {
  phase: PlanningPhase;
  changeName: string;
  complexity: ComplexityDecision;
  policy: OrchestrationPolicy;
  opinions: readonly PlanningAgentResult[];
  debate?: PlanningAgentResult;
  synthesis: PlanningAgentResult;
  budgetDecisions: readonly BudgetDecision[];
  artifactsWritten: true;
}

function scaledEstimate(
  estimate: BudgetAmount | undefined,
  count = 1,
): BudgetAmount {
  return {
    totalTokens: (estimate?.totalTokens ?? 0) * count,
    costUsd: estimate?.costUsd === null
      ? null
      : (estimate?.costUsd ?? 0) * count,
  };
}

async function runPlanning(
  phase: PlanningPhase,
  input: PlanningInput,
  dependencies: PlanningDependencies,
): Promise<PlanningResult> {
  const basePolicy = orchestrationPolicy(input.complexity.classification, {
    optionalBudgetAvailable: input.optionalBudgetAvailable,
  });
  const authoritativeContext = input.authoritativeContext ?? {};
  const supplementalFacts = dependencies.readSupplementalContext
    ? await dependencies.readSupplementalContext(input.prompt)
    : [];
  const baseRequest = {
    phase,
    changeName: input.changeName,
    prompt: input.prompt,
    complexity: input.complexity,
    authoritativeContext,
    supplementalFacts,
  };

  const opinionCount = Math.max(2, dependencies.specialistOpinionCount ?? 2);
  const budgetDecisions: BudgetDecision[] = [];
  const forecast = (
    stage: PlanningAgentStage,
    count = 1,
  ): BudgetDecision | undefined => {
    if (!dependencies.budget) return undefined;
    const decision = dependencies.budget.forecast({
      phase: "planning",
      role: "architect",
      activity: stage,
      estimate: scaledEstimate(dependencies.budgetEstimates?.[stage], count),
    });
    budgetDecisions.push(decision);
    return decision;
  };
  const opinionBudget = basePolicy.optional.specialistOpinions
    ? forecast("specialist_opinion", opinionCount)
    : undefined;
  const specialistOpinionsEnabled = basePolicy.optional.specialistOpinions &&
    opinionBudget?.status !== "skipped_optional";
  const opinions = specialistOpinionsEnabled
    ? await Promise.all(Array.from({ length: opinionCount }, (_, opinionIndex) =>
      dependencies.runAgent({
        ...baseRequest,
        policy: basePolicy,
        stage: "specialist_opinion",
        priorResults: [],
        opinionIndex,
      })
    ))
    : [];
  const debateBudget = basePolicy.optional.debate && specialistOpinionsEnabled
    ? forecast("debate")
    : undefined;
  const debateEnabled = basePolicy.optional.debate && specialistOpinionsEnabled &&
    debateBudget?.status !== "skipped_optional";
  const policy: OrchestrationPolicy = Object.freeze({
    ...basePolicy,
    optional: Object.freeze({
      specialistOpinions: specialistOpinionsEnabled,
      debate: debateEnabled,
    }),
    budgetDecision: basePolicy.budgetDecision === "minimal_route"
      ? "minimal_route"
      : specialistOpinionsEnabled && debateEnabled
        ? "optional_enabled"
        : "optional_skipped_budget",
  });
  const debate = debateEnabled
    ? await dependencies.runAgent({
      ...baseRequest,
      policy,
      stage: "debate",
      priorResults: opinions,
    })
    : undefined;
  const synthesisBudget = forecast("synthesis");
  if (synthesisBudget?.status === "blocked_mandatory") {
    throw new HarnessError(
      "BUDGET_EXHAUSTED",
      `Mandatory planning synthesis is budget-blocked: ${synthesisBudget.reason}`,
      { decision: synthesisBudget },
    );
  }
  const debated = debate ? [...opinions, debate] : opinions;
  const maxSynthesisAttempts = Math.max(1, dependencies.maxSynthesisAttempts ?? 2);
  let synthesis = await dependencies.runAgent({
    ...baseRequest,
    policy,
    stage: "synthesis",
    priorResults: debated,
  });
  for (let attempt = 1; ; attempt += 1) {
    try {
      await dependencies.writeArtifacts({
        phase,
        changeName: input.changeName,
        synthesis,
        opinions,
        debate,
      });
      break;
    } catch (error) {
      if (attempt >= maxSynthesisAttempts) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      synthesis = await dependencies.runAgent({
        ...baseRequest,
        policy,
        stage: "synthesis",
        priorResults: [
          ...debated,
          {
            model: "validator",
            content: `Your previous response was rejected: ${reason}\n\nReturn exactly one valid JSON object of the required shape, with no markdown fences and no text outside the object. Every double quote that appears inside a string value must be escaped as \\", including quoted phrases inside task descriptions or prose — never a raw " inside a JSON string.`,
          },
        ],
      });
    }
  }

  return {
    phase,
    changeName: input.changeName,
    complexity: input.complexity,
    policy,
    opinions,
    debate,
    synthesis,
    budgetDecisions: Object.freeze(budgetDecisions),
    artifactsWritten: true,
  };
}

export function propose(
  input: PlanningInput,
  dependencies: PlanningDependencies,
): Promise<PlanningResult> {
  return runPlanning("propose", input, dependencies);
}

export function refine(
  input: PlanningInput,
  dependencies: PlanningDependencies,
): Promise<PlanningResult> {
  return runPlanning("refine", input, dependencies);
}