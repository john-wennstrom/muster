import { HarnessError } from "../shared/errors.ts";
import type { UsagePhase, UsageRecord, UsageRole } from "./usage.ts";

export interface BudgetLimit {
  totalTokens?: number;
  costUsd?: number;
}

export interface BudgetConfiguration {
  run?: BudgetLimit;
  phases?: Partial<Record<UsagePhase, BudgetLimit>>;
  roles?: Partial<Record<UsageRole, BudgetLimit>>;
  tasks?: Readonly<Record<string, BudgetLimit>>;
}

export interface BudgetAmount {
  totalTokens: number;
  costUsd: number | null;
}

export type OptionalBudgetActivity =
  | "specialist_opinion"
  | "debate"
  | "exploratory_model";

export type ProtectedBudgetActivity =
  | "tests"
  | "review"
  | "final_validation"
  | "openspec_integrity"
  | "permission_enforcement"
  | "manual_checkpoint";

export type BudgetActivity =
  | OptionalBudgetActivity
  | ProtectedBudgetActivity
  | "implementation"
  | "synthesis";

export interface BudgetForecastRequest {
  phase: UsagePhase;
  role: UsageRole;
  taskId?: string;
  activity: BudgetActivity;
  estimate: BudgetAmount;
}

export interface BudgetScope {
  level: "run" | "phase" | "role" | "task";
  id: string;
}

export interface BudgetScopeEvaluation {
  scope: BudgetScope;
  limit: Readonly<BudgetLimit>;
  used: Readonly<BudgetAmount>;
  projected: Readonly<BudgetAmount>;
  exceeded: readonly ("totalTokens" | "costUsd" | "costUsdUnavailable")[];
}

export interface BudgetDecision {
  status: "allowed" | "skipped_optional" | "blocked_mandatory";
  activity: BudgetActivity;
  mandatory: boolean;
  estimate: Readonly<BudgetAmount>;
  estimatedSaving: Readonly<BudgetAmount> | null;
  scopes: readonly BudgetScopeEvaluation[];
  reason: string;
}

export interface BudgetEvaluator {
  forecast(request: BudgetForecastRequest): BudgetDecision;
}

interface MutableUsage {
  totalTokens: number;
  knownCostUsd: number;
  costUnavailable: boolean;
}

const optionalActivities = new Set<BudgetActivity>([
  "specialist_opinion",
  "debate",
  "exploratory_model",
]);

const protectedActivities = new Set<BudgetActivity>([
  "tests",
  "review",
  "final_validation",
  "openspec_integrity",
  "permission_enforcement",
  "manual_checkpoint",
]);

function invalidBudget(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("BUDGET_CONFIG_INVALID", message, details);
}

function validateNumber(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    invalidBudget(`${label} must be a finite non-negative number`, { label, value });
  }
}

function validateLimit(limit: BudgetLimit | undefined, label: string): void {
  if (!limit) return;
  validateNumber(limit.totalTokens, `${label}.totalTokens`);
  validateNumber(limit.costUsd, `${label}.costUsd`);
}

function validateConfiguration(configuration: BudgetConfiguration): void {
  validateLimit(configuration.run, "run");
  for (const [phase, limit] of Object.entries(configuration.phases ?? {})) {
    validateLimit(limit, `phases.${phase}`);
  }
  for (const [role, limit] of Object.entries(configuration.roles ?? {})) {
    validateLimit(limit, `roles.${role}`);
  }
  for (const [taskId, limit] of Object.entries(configuration.tasks ?? {})) {
    if (!taskId.trim()) invalidBudget("Task budget identifiers must be non-empty", { taskId });
    validateLimit(limit, `tasks.${taskId}`);
  }
}

function validateAmount(amount: BudgetAmount, label: string): void {
  validateNumber(amount.totalTokens, `${label}.totalTokens`);
  if (amount.costUsd !== null) validateNumber(amount.costUsd, `${label}.costUsd`);
}

function scopeKey(scope: BudgetScope): string {
  return `${scope.level}:${scope.id}`;
}

function frozenAmount(totalTokens: number, costUsd: number | null): Readonly<BudgetAmount> {
  return Object.freeze({ totalTokens, costUsd });
}

export function isProtectedMandatoryActivity(
  activity: BudgetActivity,
): activity is ProtectedBudgetActivity {
  return protectedActivities.has(activity);
}

export class BudgetLedger implements BudgetEvaluator {
  readonly #configuration: BudgetConfiguration;
  readonly #usage = new Map<string, MutableUsage>();

  constructor(configuration: BudgetConfiguration) {
    validateConfiguration(configuration);
    this.#configuration = Object.freeze({
      run: configuration.run ? Object.freeze({ ...configuration.run }) : undefined,
      phases: Object.freeze({ ...configuration.phases }),
      roles: Object.freeze({ ...configuration.roles }),
      tasks: Object.freeze({ ...configuration.tasks }),
    });
  }

  record(record: UsageRecord): void {
    const amount = frozenAmount(record.totalTokens, record.costUsd);
    validateAmount(amount, "usage");
    for (const { scope } of this.#matchingScopes(record)) {
      const key = scopeKey(scope);
      const used = this.#usage.get(key) ?? {
        totalTokens: 0,
        knownCostUsd: 0,
        costUnavailable: false,
      };
      used.totalTokens += amount.totalTokens;
      if (amount.costUsd === null) used.costUnavailable = true;
      else used.knownCostUsd += amount.costUsd;
      this.#usage.set(key, used);
    }
  }

  forecast(request: BudgetForecastRequest): BudgetDecision {
    validateAmount(request.estimate, "estimate");
    const estimate = frozenAmount(request.estimate.totalTokens, request.estimate.costUsd);
    const scopes = this.#matchingScopes(request).map(({ scope, limit }) => {
      const usage = this.#usage.get(scopeKey(scope));
      const usedCost = usage?.costUnavailable ? null : (usage?.knownCostUsd ?? 0);
      const projectedCost = usedCost === null || estimate.costUsd === null
        ? null
        : usedCost + estimate.costUsd;
      const exceeded: ("totalTokens" | "costUsd" | "costUsdUnavailable")[] = [];
      const usedTokens = usage?.totalTokens ?? 0;
      if (limit.totalTokens !== undefined && usedTokens + estimate.totalTokens > limit.totalTokens) {
        exceeded.push("totalTokens");
      }
      if (limit.costUsd !== undefined) {
        if (projectedCost === null) exceeded.push("costUsdUnavailable");
        else if (projectedCost > limit.costUsd) exceeded.push("costUsd");
      }
      return Object.freeze({
        scope,
        limit,
        used: frozenAmount(usedTokens, usedCost),
        projected: frozenAmount(usedTokens + estimate.totalTokens, projectedCost),
        exceeded: Object.freeze(exceeded),
      });
    });
    const exceeded = scopes.filter((scope) => scope.exceeded.length > 0);
    const mandatory = !optionalActivities.has(request.activity);
    const status = exceeded.length === 0
      ? "allowed"
      : mandatory
        ? "blocked_mandatory"
        : "skipped_optional";
    const reason = exceeded.length === 0
      ? `${request.activity} is within all configured budgets`
      : `${request.activity} forecast exceeds ${exceeded.map(({ scope }) =>
        `${scope.level}:${scope.id}`).join(", ")} budget`;

    return Object.freeze({
      status,
      activity: request.activity,
      mandatory,
      estimate,
      estimatedSaving: status === "skipped_optional" ? estimate : null,
      scopes: Object.freeze(scopes),
      reason,
    });
  }

  #matchingScopes(input: Pick<BudgetForecastRequest, "phase" | "role" | "taskId">): {
    scope: Readonly<BudgetScope>;
    limit: Readonly<BudgetLimit>;
  }[] {
    const matches: { scope: Readonly<BudgetScope>; limit: Readonly<BudgetLimit> }[] = [];
    const add = (level: BudgetScope["level"], id: string, limit: BudgetLimit | undefined) => {
      if (limit) matches.push({
        scope: Object.freeze({ level, id }),
        limit: Object.freeze({ ...limit }),
      });
    };
    add("run", "run", this.#configuration.run);
    add("phase", input.phase, this.#configuration.phases?.[input.phase]);
    add("role", input.role, this.#configuration.roles?.[input.role]);
    if (input.taskId) add("task", input.taskId, this.#configuration.tasks?.[input.taskId]);
    return matches;
  }
}