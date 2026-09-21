import type { SupplementalFact } from "../integrations/optional-adapters.ts";
import type {
  BudgetAmount,
  BudgetDecision,
  BudgetEvaluator,
} from "../telemetry/budget.ts";
import { HarnessError } from "../shared/errors.ts";
import type { ComplexityDecision } from "./complexity-router.ts";
import { LANE_POLICY, type Lane } from "./lane.ts";

export type PlanningPhase = "propose" | "refine";
export type PlanningAgentStage = "specialist_opinion" | "debate" | "synthesis";

/** What one planning run does, read from the lane policy table and reduced by the optional budget. */
export interface PlanningPolicy {
  lane: Lane;
  optional: {
    specialistOpinions: boolean;
    debate: boolean;
  };
  budgetDecision: "optional_enabled" | "optional_skipped_budget" | "minimal_route";
}

export interface PlanningInput {
  changeName: string;
  prompt: string;
  lane: Lane;
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
  policy: PlanningPolicy;
  authoritativeContext: Readonly<Record<string, unknown>>;
  supplementalFacts: readonly SupplementalFact[];
  priorResults: readonly PlanningAgentResult[];
  opinionIndex?: number;
}

export interface PlanningAgentResult {
  model: string;
  content: string;
}

export interface PlanningDependencies {
  runAgent(request: PlanningAgentRequest): Promise<PlanningAgentResult>;
  readSupplementalContext?(query: string): Promise<readonly SupplementalFact[]>;
  specialistOpinionCount?: number;
  budget?: BudgetEvaluator;
  budgetEstimates?: Partial<Record<PlanningAgentStage, BudgetAmount>>;
}

export interface PlanningResult {
  phase: PlanningPhase;
  changeName: string;
  complexity: ComplexityDecision;
  policy: PlanningPolicy;
  opinions: readonly PlanningAgentResult[];
  debate?: PlanningAgentResult;
  synthesis: PlanningAgentResult;
  budgetDecisions: readonly BudgetDecision[];
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
  const lanePolicy = LANE_POLICY[input.lane];
  const optionalEligible = lanePolicy.specialistOpinions > 0 || lanePolicy.debate;
  const optionalEnabled = optionalEligible && input.optionalBudgetAvailable;
  const basePolicy: PlanningPolicy = Object.freeze({
    lane: input.lane,
    optional: Object.freeze({
      specialistOpinions: lanePolicy.specialistOpinions > 0 && optionalEnabled,
      debate: lanePolicy.debate && optionalEnabled,
    }),
    budgetDecision: !optionalEligible
      ? "minimal_route" as const
      : optionalEnabled
        ? "optional_enabled" as const
        : "optional_skipped_budget" as const,
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

  const opinionCount = Math.max(lanePolicy.specialistOpinions, dependencies.specialistOpinionCount ?? lanePolicy.specialistOpinions);
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
  const policy: PlanningPolicy = Object.freeze({
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
  const synthesis = await dependencies.runAgent({
    ...baseRequest,
    policy,
    stage: "synthesis",
    priorResults: debated,
  });

  return {
    phase,
    changeName: input.changeName,
    complexity: input.complexity,
    policy,
    opinions,
    debate,
    synthesis,
    budgetDecisions: Object.freeze(budgetDecisions),
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