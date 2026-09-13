import type { DependencyReport } from "../agents/reports.ts";
import { renderDependencyReports } from "../agents/reports.ts";

export type ContextPriority = "required" | "relevant" | "available" | "excluded";

export interface ContextSlice {
  id: string;
  priority: ContextPriority;
  content: string;
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
}

export interface TaskCapsule {
  taskId: string;
  content: string;
  tokenBudget: number;
  tokenEstimate: number;
  included: readonly { id: string; priority: Exclude<ContextPriority, "excluded"> }[];
  available: readonly string[];
  excluded: readonly string[];
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
  for (const slice of slices.filter((candidate) => candidate.priority === "relevant")) {
    if (tokenEstimate + slice.tokenEstimate > budget) continue;
    tokenEstimate += slice.tokenEstimate;
    included.push({ id: slice.id, priority: "relevant" });
    contents.push(slice.content);
  }
  const available = slices.filter((slice) => slice.priority === "available").map((slice) => slice.id);
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
  };
}