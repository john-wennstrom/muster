import type { DependencyReport } from "../agents/reports.ts";
import { renderDependencyReports } from "../agents/reports.ts";
import {
  CAPSULE_DEMOTE_BELOW,
  CAPSULE_DEMOTE_CONFIDENCE,
  CAPSULE_OVERSIZED_AT,
  CAPSULE_OVERSIZED_CONFIDENCE,
} from "../judgment/gates.ts";

export type ContextPriority = "required" | "relevant" | "available" | "excluded";

export interface ContextSlice {
  id: string;
  priority: ContextPriority;
  content: string;
  tokenEstimate: number;
  /** Repository path of a file-backed slice, so the credential denylist can be applied to it. Ignored here. */
  path?: string;
}

/** A slice's judged necessity: an expectation over unrelated (0), background, useful, and required (3). */
export interface SliceRanking {
  score: number;
  confidence: number;
}

/** Rankings by slice identifier; a slice without an entry is unscored. */
export type CapsuleRanking = Readonly<Record<string, SliceRanking>>;

export interface OversizedRequiredSlice extends SliceRanking {
  id: string;
  tokenEstimate: number;
}

export interface TaskCapsuleContract {
  taskId: string;
  definition: string;
  requirements: readonly string[];
  scenarios: readonly string[];
  decisions: readonly string[];
  readScopes: readonly string[];
  writeScopes: readonly string[];
  acceptance: readonly string[];
  tokenBudget: number;
}

export interface AssembleTaskCapsuleOptions {
  contract: TaskCapsuleContract;
  requiredTokenEstimate: number;
  dependencyReports?: readonly DependencyReport[];
  slices?: readonly ContextSlice[];
  /** When supplied, relevant slices are packed by judged necessity rather than list order. */
  ranking?: CapsuleRanking;
}

export interface TaskCapsule {
  taskId: string;
  content: string;
  tokenBudget: number;
  tokenEstimate: number;
  included: readonly { id: string; priority: Exclude<ContextPriority, "excluded"> }[];
  available: readonly string[];
  excluded: readonly string[];
  /** Present only when a ranking was supplied: the ranking of every slice it scored. */
  ranking?: CapsuleRanking;
  /** Present only when a ranking was supplied: slices judged required that did not fit. */
  oversizedRequired?: readonly OversizedRequiredSlice[];
}

export class ContextAssemblyError extends Error {
  constructor(
    readonly code: "CONTEXT_REQUIRED_OVER_BUDGET" | "CONTEXT_SLICE_INVALID",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ContextAssemblyError";
  }
}

function validateTokenEstimate(value: number, id: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ContextAssemblyError(
      "CONTEXT_SLICE_INVALID",
      `Context slice ${id} has an invalid token estimate`,
      { id, tokenEstimate: value },
    );
  }
  return value;
}

function rankingOf(ranking: CapsuleRanking | undefined, id: string): SliceRanking | undefined {
  if (!ranking || !Object.hasOwn(ranking, id)) return undefined;
  const entry = ranking[id]!;
  return Number.isFinite(entry.score) && Number.isFinite(entry.confidence) ? entry : undefined;
}

/** Confidently judged unnecessary: below the floor, at or above the confidence. Anything else is not. */
export function isDemotedByRanking(entry: SliceRanking | undefined): boolean {
  return entry !== undefined && entry.score < CAPSULE_DEMOTE_BELOW && entry.confidence >= CAPSULE_DEMOTE_CONFIDENCE;
}

/** Confidently judged required: at or above the floor and the confidence. */
export function isRequiredByRanking(entry: SliceRanking | undefined): boolean {
  return entry !== undefined && entry.score >= CAPSULE_OVERSIZED_AT && entry.confidence >= CAPSULE_OVERSIZED_CONFIDENCE;
}

/**
 * The order relevant slices are considered in: ranked slices by descending score times
 * confidence, ties in list order, then unranked slices in list order. Slices the ranking
 * confidently demotes are not candidates.
 */
function rankedOrder(
  candidates: readonly ContextSlice[],
  ranking: CapsuleRanking,
): ContextSlice[] {
  return candidates
    .map((slice, position) => ({ slice, position, entry: rankingOf(ranking, slice.id) }))
    .filter(({ entry }) => !isDemotedByRanking(entry))
    .sort((left, right) => {
      if ((left.entry === undefined) !== (right.entry === undefined)) return left.entry === undefined ? 1 : -1;
      const leftRank = left.entry ? left.entry.score * left.entry.confidence : 0;
      const rightRank = right.entry ? right.entry.score * right.entry.confidence : 0;
      return rightRank - leftRank || left.position - right.position;
    })
    .map(({ slice }) => slice);
}

function requiredContent(
  contract: TaskCapsuleContract,
  dependencyReports: readonly DependencyReport[],
): string {
  const section = (heading: string, values: readonly string[]) => [
    `## ${heading}`,
    ...(values.length ? values.map((value) => `- ${value}`) : ["- None"]),
  ].join("\n");
  return [
    `# Task ${contract.taskId}`,
    contract.definition,
    section("Requirements", contract.requirements),
    section("Scenarios", contract.scenarios),
    section("Design Decisions", contract.decisions),
    section("Read Scopes", contract.readScopes),
    section("Write Scopes", contract.writeScopes),
    section("Acceptance", contract.acceptance),
    "## Dependency Reports",
    renderDependencyReports(dependencyReports),
  ].join("\n\n");
}

export function assembleTaskCapsule(options: AssembleTaskCapsuleOptions): TaskCapsule {
  const budget = options.contract.tokenBudget;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new ContextAssemblyError("CONTEXT_SLICE_INVALID", "Task token budget must be positive", { budget });
  }
  const requiredTokens = validateTokenEstimate(options.requiredTokenEstimate, "task-contract");
  if (requiredTokens > budget) {
    throw new ContextAssemblyError(
      "CONTEXT_REQUIRED_OVER_BUDGET",
      `Required context for task ${options.contract.taskId} exceeds its token budget`,
      { taskId: options.contract.taskId, requiredTokens, budget },
    );
  }

  const slices = options.slices ?? [];
  const seen = new Set<string>();
  for (const slice of slices) {
    if (!slice.id.trim() || seen.has(slice.id)) {
      throw new ContextAssemblyError("CONTEXT_SLICE_INVALID", "Context slice identifiers must be unique", { id: slice.id });
    }
    seen.add(slice.id);
    validateTokenEstimate(slice.tokenEstimate, slice.id);
  }
  const unexpectedRequired = slices.filter((slice) => slice.priority === "required");
  const allRequiredTokens = requiredTokens + unexpectedRequired.reduce((sum, slice) => sum + slice.tokenEstimate, 0);
  if (allRequiredTokens > budget) {
    throw new ContextAssemblyError(
      "CONTEXT_REQUIRED_OVER_BUDGET",
      `Required context for task ${options.contract.taskId} exceeds its token budget`,
      { taskId: options.contract.taskId, requiredTokens: allRequiredTokens, budget },
    );
  }

  let tokenEstimate = allRequiredTokens;
  const included: Array<{ id: string; priority: "required" | "relevant" }> = [
    { id: "task-contract", priority: "required" as const },
    ...unexpectedRequired.map((slice) => ({ id: slice.id, priority: "required" as const })),
  ];
  const contents = [
    requiredContent(options.contract, options.dependencyReports ?? []),
    ...unexpectedRequired.map((slice) => slice.content),
  ];
  const relevant = slices.filter((candidate) => candidate.priority === "relevant");
  const ranking = options.ranking;
  const oversizedRequired: OversizedRequiredSlice[] = [];
  for (const slice of ranking ? rankedOrder(relevant, ranking) : relevant) {
    if (tokenEstimate + slice.tokenEstimate > budget) {
      const entry = rankingOf(ranking, slice.id);
      if (entry && isRequiredByRanking(entry)) {
        oversizedRequired.push({ id: slice.id, ...entry, tokenEstimate: slice.tokenEstimate });
      }
      continue;
    }
    tokenEstimate += slice.tokenEstimate;
    included.push({ id: slice.id, priority: "relevant" });
    contents.push(slice.content);
  }
  // Without a ranking a relevant slice that is left out is simply left out, as it always was.
  // With one, every relevant slice that is left out is available on demand.
  const includedIds = new Set(included.map((slice) => slice.id));
  const available = slices
    .filter((slice) => slice.priority === "available"
      || (ranking !== undefined && slice.priority === "relevant" && !includedIds.has(slice.id)))
    .map((slice) => slice.id);
  if (available.length) contents.push(`## Available On Demand\n${available.map((id) => `- ${id}`).join("\n")}`);
  const excluded = slices.filter((slice) => slice.priority === "excluded").map((slice) => slice.id);
  return {
    taskId: options.contract.taskId,
    content: contents.join("\n\n"),
    tokenBudget: budget,
    tokenEstimate,
    included,
    available,
    excluded,
    ...(ranking
      ? {
          ranking: Object.fromEntries(
            slices.flatMap((slice) => {
              const entry = rankingOf(ranking, slice.id);
              return entry ? [[slice.id, { score: entry.score, confidence: entry.confidence }] as const] : [];
            }),
          ),
          oversizedRequired,
        }
      : {}),
  };
}