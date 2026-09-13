import type { SupplementalFact } from "../integrations/optional-adapters.ts";
import {
  propose,
  type PlanningDependencies,
  type PlanningInput,
  type PlanningResult,
} from "./planning.ts";

export interface ExploreInput {
  prompt: string;
  authoritativeContext?: Readonly<Record<string, unknown>>;
}

export interface ExploreAgentRequest {
  phase: "explore";
  access: "read";
  prompt: string;
  authoritativeContext: Readonly<Record<string, unknown>>;
  supplementalFacts: readonly SupplementalFact[];
}

export interface ExploreAgentResult {
  model: string;
  content: string;
}

export interface ExploreDependencies {
  runAgent(request: ExploreAgentRequest): Promise<ExploreAgentResult>;
  readSupplementalContext?(query: string): Promise<readonly SupplementalFact[]>;
}

export interface ExplorationResult {
  prompt: string;
  analysis: ExploreAgentResult;
  supplementalFacts: readonly SupplementalFact[];
  artifactsWritten: false;
}

export async function explore(
  input: ExploreInput,
  dependencies: ExploreDependencies,
): Promise<ExplorationResult> {
  const authoritativeContext = input.authoritativeContext ?? {};
  const supplementalFacts = dependencies.readSupplementalContext
    ? await dependencies.readSupplementalContext(input.prompt)
    : [];
  const analysis = await dependencies.runAgent({
    phase: "explore",
    access: "read",
    prompt: input.prompt,
    authoritativeContext,
    supplementalFacts,
  });
  return {
    prompt: input.prompt,
    analysis,
    supplementalFacts,
    artifactsWritten: false,
  };
}

export function promoteExploration(
  exploration: ExplorationResult,
  input: Omit<PlanningInput, "prompt">,
  dependencies: PlanningDependencies,
): Promise<PlanningResult> {
  return propose({
    ...input,
    prompt: `${exploration.prompt}\n\nExploration:\n${exploration.analysis.content}`,
  }, dependencies);
}