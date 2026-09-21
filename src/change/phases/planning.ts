import { ensureFusionDrivenSchemaInstalled } from "../../openspec/fusion-driven-schema.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import { createJudgmentRuntime, type JudgmentRuntime } from "../../judgment/ask.ts";
import type { PlanningAgentStage } from "../../controller/planning.ts";
import type { Lane } from "../../controller/lane.ts";
import type { retrieveCandidates } from "../../context/candidates.ts";
import { createChangeUsageStore } from "../../persistence/change-usage-store.ts";
import type { ModelStack } from "../../agents/model-stack.ts";
import { DEFAULT_BUDGET_ESTIMATES, planningBudget } from "../../planning/budget.ts";
import { runPlanning } from "../../planning/run.ts";
import type { runPlanningSession } from "../../planning/session.ts";
import type { BudgetAmount, BudgetLedger } from "../../telemetry/budget.ts";
import type { AgentRunObserver } from "../agent-progress.ts";
import type { CommandOutcome } from "../command.ts";
import { resolveModelStack } from "../models.ts";

export interface ProductionPlanningOptions {
  onAgentStart?: AgentRunObserver;
  cwd: string;
  changeName: string;
  phase: "propose" | "refine";
  runId?: string;
  prompt: string;
  /** A lane the user chose with `lane=`, which overrides triage. */
  lane?: Lane;
  signal?: AbortSignal;
  argv?: readonly string[];
  openSpec?: OpenSpecAdapter;
  modelStack?: ModelStack;
  budget?: BudgetLedger;
  /** Replaces the runtime built from the environment; tests inject a scripted or dead client. */
  judgment?: JudgmentRuntime;
  /** Replaces candidate retrieval; tests inject a spy or a failure. */
  retrieve?: typeof retrieveCandidates;
  budgetEstimates?: Partial<Record<PlanningAgentStage, BudgetAmount>>;
  /** Replaces the planning session, so tests run without a child process. */
  session?: typeof runPlanningSession;
  ensureSchema?(): Promise<void>;
}

/** Runs `/change propose` and `/change refine`: builds the run's context, plans, and maps the result to an outcome. */
export async function runProductionPlanning(options: ProductionPlanningOptions): Promise<CommandOutcome> {
  const argv = options.argv ?? process.argv;
  const runId = options.runId ?? `${options.phase}-${options.changeName}`;
  const usageStore = createChangeUsageStore(options.cwd);
  const budget = options.budget ?? planningBudget(argv);
  const result = await runPlanning({
    ...options,
    runId,
    usageStore,
    budget,
    openSpec: options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal }),
    stack: options.modelStack ?? resolveModelStack(argv),
    budgetEstimates: { ...DEFAULT_BUDGET_ESTIMATES, ...options.budgetEstimates },
    judgment: options.judgment ?? createJudgmentRuntime({ env: process.env, store: usageStore, budget }),
    ensureSchema: options.ensureSchema ?? (() => ensureFusionDrivenSchemaInstalled().then(() => undefined)),
  });
  if (result.kind === "blocked") {
    return {
      status: "blocked",
      action: options.phase,
      changeName: options.changeName,
      runId,
      summary: result.summary,
      next: result.question,
      blocker: { kind: "lifecycle", message: result.question },
    };
  }
  return {
    status: "success",
    action: options.phase,
    changeName: options.changeName,
    runId,
    summary: `${options.phase} completed on the ${result.lane} lane; OpenSpec artifacts were written.${
      result.notes.length > 0 ? `\n\nTasks merged:\n${result.notes.map((note) => `- ${note}`).join("\n")}` : ""
    }`,
    next: `/change review ${options.changeName}`,
  };
}
