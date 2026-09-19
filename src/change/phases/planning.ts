import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  type ModelSlot,
  type ModelStack,
  type Thinking,
} from "../../../extensions/fusion-harness/modules/model-stack.ts";
import { newRun, runError, runOk } from "../../../extensions/fusion-harness/modules/runtime.ts";
import { runLegacyReadOnlyChild } from "../../agents/legacy-adapter.ts";
import {
  propose,
  refine,
  type PlanningAgentRequest,
  type PlanningAgentResult,
  type PlanningArtifactWriteRequest,
  type PlanningPhase,
} from "../../controller/planning.ts";
import { classifyChange } from "../../controller/complexity-router.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import {
  CORE_PLANNING_ARTIFACT_IDS,
  ensureFusionDrivenSchemaInstalled,
  FUSION_DRIVEN_SCHEMA_NAME,
} from "../../openspec/fusion-driven-schema.ts";
import type { OpenSpecInstructions, OpenSpecStatus } from "../../openspec/protocol.ts";
import { createChangeUsageStore, recordChangeUsage } from "../../persistence/change-usage-store.ts";
import { parseReviewArtifact } from "../../review/review-artifact.ts";
import { readCliFlag } from "../../shared/cli-flags.ts";
import { readFileOrNull } from "../../shared/fs.ts";
import { isWithin } from "../../shared/paths.ts";
import { HarnessError } from "../../shared/errors.ts";
import { usageFromLegacyRun } from "../../telemetry/usage.ts";
import { BudgetLedger, type BudgetAmount, type BudgetLimit } from "../../telemetry/budget.ts";
import type { CommandOutcome } from "../command.ts";
import { resolveModelStack } from "../models.ts";
import type { AgentRunObserver } from "../agent-progress.ts";

const PLANNING_TIMEOUT_MS = 30 * 60 * 1000;
const PREFLIGHT_MAX_TOOL_CALLS = 6;
const DEFAULT_PLANNING_MAX_TOKENS = 1_000_000;
const DEFAULT_PLANNING_MAX_COST_USD = 1.5;
const DEFAULT_BUDGET_ESTIMATES = {
  preflight: { totalTokens: 15_000, costUsd: 0.08 },
  specialist_opinion: { totalTokens: 20_000, costUsd: 0.12 },
  debate: { totalTokens: 25_000, costUsd: 0.15 },
  synthesis: { totalTokens: 50_000, costUsd: 0.3 },
} as const satisfies Record<"preflight" | PlanningAgentRequest["stage"], BudgetAmount>;

// Some models include "question" as "" instead of omitting it, even when
// disposition isn't needs_clarification (a real, observed response shape).
// Strip it before validation instead of failing the whole preflight over a
// harmless placeholder value.
function dropEmptyPreflightQuestion(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.question !== "") return input;
  const { question: _question, ...rest } = record;
  return rest;
}

const planningPreflightSchema = z.preprocess(
  dropEmptyPreflightQuestion,
  z.object({
    disposition: z.enum(["proceed", "needs_clarification", "already_satisfied"]),
    summary: z.string().min(1),
    evidence: z.array(z.object({
      path: z.string().min(1),
      reason: z.string().min(1),
    }).strict()).max(8),
    question: z.string().min(1).optional(),
  }).strict().superRefine((value, context) => {
    if (value.disposition === "needs_clarification" && !value.question) {
      context.addIssue({ code: "custom", message: "Clarification disposition requires a question" });
    }
  }),
);

export type PlanningPreflight = z.infer<typeof planningPreflightSchema>;

export interface PlanningPreflightRequest {
  changeName: string;
  prompt: string;
}

const UNLIMITED_BUDGET_VALUES = new Set(["unlimited", "none", "off"]);

/** Returns `undefined` for "unlimited"/"none"/"off", meaning that dimension is not capped. */
function parseBudgetLimit(value: string, fallback: number, label: string): number | undefined {
  if (!value) return fallback;
  if (UNLIMITED_BUDGET_VALUES.has(value.trim().toLowerCase())) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HarnessError(
      "BUDGET_CONFIG_INVALID",
      `${label} must be a positive number, or "unlimited"/"none"/"off" to disable the cap`,
      { label, value },
    );
  }
  return parsed;
}

function planningBudget(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): BudgetLedger {
  const totalTokens = parseBudgetLimit(
    readCliFlag("planning-max-tokens", argv) || env.MUSTER_PLANNING_MAX_TOKENS?.trim() || "",
    DEFAULT_PLANNING_MAX_TOKENS,
    "planning max tokens",
  );
  const costUsd = parseBudgetLimit(
    readCliFlag("planning-max-cost", argv) || env.MUSTER_PLANNING_MAX_COST_USD?.trim() || "",
    DEFAULT_PLANNING_MAX_COST_USD,
    "planning max cost",
  );
  const limit: BudgetLimit = {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return new BudgetLedger({ phases: Object.keys(limit).length > 0 ? { planning: limit } : {} });
}

function preflightPrompt(request: PlanningPreflightRequest): string {
  return [
    "Determine whether the requested change is needed in the checked-out repository.",
    `Change: ${request.changeName}`,
    `User request: ${request.prompt}`,
    `Use at most ${PREFLIGHT_MAX_TOOL_CALLS} read/search calls. Follow the nearest controlling code path only.`,
    "Stop as soon as file evidence distinguishes proceed, needs_clarification, or already_satisfied.",
    "If checked-out behavior already satisfies the request, do not invent adjacent improvements; return already_satisfied and ask which branch, deployment, or entry point still fails.",
    "If ambiguity prevents a bounded proposal, return needs_clarification with one specific question.",
    "Return exactly one JSON object: {\"disposition\":\"proceed|needs_clarification|already_satisfied\",\"summary\":\"...\",\"evidence\":[{\"path\":\"repo/relative/path\",\"reason\":\"...\"}],\"question\":\"...\"}. Omit the \"question\" field entirely unless disposition is \"needs_clarification\" — do not include it as an empty string.",
  ].join("\n\n");
}

/**
 * A REVISE verdict's required changes are the whole reason `refine` is being
 * run again — surface them automatically instead of relying on the caller to
 * copy them out of review.md by hand. `undefined` when there's no review.md
 * yet, or the last review already approved (nothing to fold in).
 */
async function pendingReviewFeedback(changeRoot: string): Promise<string | undefined> {
  const reviewPath = resolve(changeRoot, "review.md");
  const contents = await readFileOrNull(reviewPath);
  if (!contents) return undefined;
  const review = parseReviewArtifact(contents, reviewPath);
  if (review.verdict !== "REVISE") return undefined;
  return [
    `The most recent planning review (round ${review.round}) requested REVISE. Address every required change below before returning to review:`,
    ...review.requiredChanges.map((change) => `- ${change}`),
    ...(review.criticalFindings.length > 0
      ? ["", "Critical findings:", ...review.criticalFindings.map((finding) => `- ${finding}`)]
      : []),
  ].join("\n");
}

function embeddedJsonObjects(content: string): unknown[] {
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(content.slice(start, index + 1)));
        } catch {
          // Ignore malformed candidates; the caller reports one structured parse error.
        }
        start = -1;
      }
    }
  }
  return objects;
}

export function parsePreflight(content: string): PlanningPreflight {
  const objects = embeddedJsonObjects(content.trim());
  if (objects.length !== 1) {
    throw new HarnessError("PLANNING_AGENT_FAILED", "Planning preflight must return exactly one JSON object", {
      objectCount: objects.length,
    });
  }
  const value = objects[0];
  const result = planningPreflightSchema.safeParse(value);
  if (result.success) return result.data;
  throw new HarnessError("PLANNING_AGENT_FAILED", "Planning preflight returned an invalid disposition", {
    issues: result.error.issues,
  });
}

const artifactBundleSchema = z.object({
  artifacts: z.array(z.object({
    path: z.string().min(1),
    content: z.string().min(1),
  }).strict()).min(3),
}).strict();

function parseArtifactBundle(content: string): z.infer<typeof artifactBundleSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch (cause) {
    throw new HarnessError(
      "PLANNING_ARTIFACT_INVALID",
      "Planning synthesis did not return one JSON artifact bundle",
      {},
      { cause },
    );
  }
  const result = artifactBundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new HarnessError(
      "PLANNING_ARTIFACT_INVALID",
      "Planning synthesis returned an incompatible artifact bundle",
      { issues: result.error.issues },
    );
  }
  return result.data;
}

function allowedArtifactPath(changeRoot: string, path: string): string {
  if (isAbsolute(path)) {
    throw new HarnessError("PLANNING_ARTIFACT_INVALID", "Planning artifact paths must be relative", { path });
  }
  const normalized = path.replaceAll("\\", "/");
  const fixed = new Set(["proposal.md", "design.md", "tasks.md"]);
  const isSpec = /^specs\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/spec\.md$/.test(normalized);
  if (!fixed.has(normalized) && !isSpec) {
    throw new HarnessError(
      "PLANNING_ARTIFACT_INVALID",
      `Planning synthesis attempted an unsupported artifact path: ${path}`,
      { path },
    );
  }
  const destination = resolve(changeRoot, normalized);
  if (!isWithin(changeRoot, destination)) {
    throw new HarnessError("PLANNING_ARTIFACT_INVALID", "Planning artifact path escapes the change root", { path });
  }
  return destination;
}

function planningPrompt(
  request: PlanningAgentRequest,
  status: OpenSpecStatus,
  instructions: readonly OpenSpecInstructions[],
): string {
  const previous = request.priorResults.length
    ? request.priorResults.map((result, index) => `RESULT ${index + 1} (${result.model})\n${result.content}`).join("\n\n")
    : "None";
  const common = [
    `Phase: ${request.phase}`,
    `Stage: ${request.stage}`,
    `Change: ${request.changeName}`,
    `User request: ${request.prompt}`,
    `Complexity: ${request.complexity.classification} (${request.complexity.reason})`,
    `Authoritative context: ${JSON.stringify(request.authoritativeContext)}`,
    `OpenSpec artifact instructions: ${JSON.stringify(instructions)}`,
    `Prior results:\n${previous}`,
  ];
  if (request.stage !== "synthesis") {
    return [...common, "Return concise planning analysis for the synthesis agent. Do not edit files."].join("\n\n");
  }
  return [
    ...common,
    "Return exactly one JSON object with this shape: {\"artifacts\":[{\"path\":\"proposal.md\",\"content\":\"...\"},{\"path\":\"design.md\",\"content\":\"...\"},{\"path\":\"specs/<capability>/spec.md\",\"content\":\"...\"},{\"path\":\"tasks.md\",\"content\":\"...\"}]}. Do not use markdown fences.",
    "Use OpenSpec delta-spec headings and four-hash WHEN/THEN scenarios. Follow the tasks artifact's own instructions and template above for how to structure each checkbox.",
  ].join("\n\n");
}

export function thinkingForPlanning(classification: ReturnType<typeof classifyChange>["classification"], configured: Thinking): Thinking {
  if (classification === "direct") return "low";
  if (classification === "bounded") return "medium";
  return configured;
}

function affectedCapability(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const match = normalized.match(/(?:^|\/)features\/([^/]+)\//)
    ?? normalized.match(/(?:^|\/)src\/([^/]+)\//);
  return match?.[1];
}

function slotForRequest(stack: ModelStack, request: PlanningAgentRequest): ModelSlot {
  if (request.stage === "specialist_opinion" && stack.builders.length > 0) {
    return stack.builders[(request.opinionIndex ?? 0) % stack.builders.length]!;
  }
  return stack.architect;
}

export interface ProductionPlanningOptions {
  onAgentStart?: AgentRunObserver;
  cwd: string;
  changeName: string;
  phase: PlanningPhase;
  runId?: string;
  prompt: string;
  signal?: AbortSignal;
  argv?: readonly string[];
  openSpec?: OpenSpecAdapter;
  modelStack?: ModelStack;
  budget?: BudgetLedger;
  budgetEstimates?: Partial<Record<"preflight" | PlanningAgentRequest["stage"], BudgetAmount>>;
  runPreflight?(request: PlanningPreflightRequest, slot: ModelSlot): Promise<PlanningPreflight>;
  runAgent?(request: PlanningAgentRequest, status: OpenSpecStatus, slot: ModelSlot): Promise<PlanningAgentResult>;
  ensureSchema?(): Promise<void>;
}

export async function runProductionPlanning(options: ProductionPlanningOptions): Promise<CommandOutcome> {
  const adapter = options.openSpec ?? new OpenSpecAdapter({ cwd: options.cwd, signal: options.signal });
  const argv = options.argv ?? process.argv;
  const stack = options.modelStack ?? resolveModelStack(argv);
  const planningRunId = options.runId ?? `${options.phase}-${options.changeName}`;
  const usageStore = createChangeUsageStore(options.cwd);
  const budget = options.budget ?? planningBudget(argv);
  const budgetEstimates = { ...DEFAULT_BUDGET_ESTIMATES, ...options.budgetEstimates };
  const runChild = async (input: {
    prompt: string;
    slot: ModelSlot;
    stage: "preflight" | PlanningAgentRequest["stage"];
    thinking: Thinking;
    boundedDiscovery?: boolean;
  }): Promise<string> => {
    const run = newRun(input.slot.architect ? "ARCHITECT" : "BUILDER", input.slot.model, input.slot);
    const childId = `${input.stage}-${randomUUID()}`;
    try {
      await runLegacyReadOnlyChild({
        run,
        modelStack: stack,
        onAgentStart: options.onAgentStart,
        prompt: input.prompt,
        systemPrompt: input.slot.systemPrompt,
        appendSystemPrompts: input.slot.appendSystemPrompts,
        role: "architect",
        runId: planningRunId,
        childId,
        taskId: `planning.${input.stage}`,
        description: `${options.phase} ${options.changeName}: ${input.stage}`,
        assignee: input.slot.id,
        thinking: input.thinking,
        toolMode: input.boundedDiscovery ? "brokered" : "standard",
        maxRequests: input.boundedDiscovery ? PREFLIGHT_MAX_TOOL_CALLS : undefined,
        sessionDir: resolve(options.cwd, ".fusion", "runs", planningRunId, "sessions", childId),
        cwd: options.cwd,
        timeoutMs: PLANNING_TIMEOUT_MS,
        signal: options.signal,
      });
    } finally {
      const usage = usageFromLegacyRun(planningRunId, "planning", run, `planning.${input.stage}`);
      await recordChangeUsage(usageStore, options.changeName, [usage]);
      budget.record(usage);
    }
    if (!runOk(run)) {
      throw new HarnessError("PLANNING_AGENT_FAILED", `Planning agent failed: ${runError(run)}`, {
        phase: options.phase,
        stage: input.stage,
        model: input.slot.model,
      });
    }
    return run.text;
  };
  // Refining against an existing change: fetch its status early so a pending
  // REVISE's required changes can be folded into the prompt before preflight
  // runs, not just before synthesis — otherwise a bare `/change refine` with
  // no argument reaches preflight with nothing to go on.
  const earlyStatus = options.phase === "refine" ? await adapter.status(options.changeName) : undefined;
  const reviewFeedback = earlyStatus ? await pendingReviewFeedback(resolve(earlyStatus.changeRoot)) : undefined;
  const effectivePrompt = reviewFeedback
    ? (options.prompt ? `${options.prompt}\n\n${reviewFeedback}` : reviewFeedback)
    : options.prompt;

  const preflightBudget = budget.forecast({
    phase: "planning",
    role: "architect",
    activity: "preflight",
    estimate: budgetEstimates.preflight,
  });
  if (preflightBudget.status === "blocked_mandatory") {
    throw new HarnessError("BUDGET_EXHAUSTED", `Planning preflight is budget-blocked: ${preflightBudget.reason}`, {
      decision: preflightBudget,
    });
  }
  const preflight = options.runPreflight
    ? await options.runPreflight({ changeName: options.changeName, prompt: effectivePrompt }, stack.architect)
    : parsePreflight(await runChild({
      prompt: preflightPrompt({ changeName: options.changeName, prompt: effectivePrompt }),
      slot: stack.architect,
      stage: "preflight",
      thinking: "low",
      boundedDiscovery: true,
    }));
  if (preflight.disposition !== "proceed") {
    const question = preflight.question
      ?? "Which branch, deployment, or entry point still exhibits the behavior you want changed?";
    return {
      status: "blocked",
      action: options.phase,
      changeName: options.changeName,
      runId: planningRunId,
      summary: `${preflight.summary}\n\nEvidence:\n${preflight.evidence.map(({ path, reason }) => `- ${path}: ${reason}`).join("\n")}`,
      next: question,
      blocker: { kind: "lifecycle", message: question },
    };
  }
  if (options.phase === "propose") {
    try {
      await adapter.status(options.changeName);
    } catch (error) {
      if (!(error instanceof HarnessError) || error.code !== "OPENSPEC_COMMAND_FAILED") throw error;
      const ensureSchema = options.ensureSchema ?? (() => ensureFusionDrivenSchemaInstalled().then(() => undefined));
      await ensureSchema();
      await adapter.createChange(options.changeName, options.prompt || `Plan ${options.changeName}`, FUSION_DRIVEN_SCHEMA_NAME);
    }
  }
  const status = earlyStatus ?? await adapter.status(options.changeName);
  const changeRoot = resolve(status.changeRoot);
  const artifactIds = (status.actionContext.planningArtifacts.length
    ? status.actionContext.planningArtifacts
    : status.artifacts.map(({ id }) => id)
  ).filter((id) => CORE_PLANNING_ARTIFACT_IDS.has(id));
  const instructions = await Promise.all(artifactIds.map((artifact) => adapter.instructions(artifact, options.changeName)));
  const runAgent = options.runAgent ?? (async (request: PlanningAgentRequest, current: OpenSpecStatus, slot: ModelSlot) => {
    const content = await runChild({
      prompt: planningPrompt(request, current, instructions),
      slot,
      stage: request.stage,
      thinking: thinkingForPlanning(request.complexity.classification, slot.thinking),
    });
    return { model: slot.model, content };
  });

  const dependencies = {
    runAgent: (request: PlanningAgentRequest) => runAgent(request, status, slotForRequest(stack, request)),
    async writeArtifacts(request: PlanningArtifactWriteRequest) {
      const bundle = parseArtifactBundle(request.synthesis.content);
      const seen = new Set<string>();
      const prepared = bundle.artifacts.map((artifact) => {
        const path = artifact.path.replaceAll("\\", "/");
        if (seen.has(path)) {
          throw new HarnessError("PLANNING_ARTIFACT_INVALID", `Planning synthesis duplicated ${path}`, { path });
        }
        seen.add(path);
        return { ...artifact, destination: allowedArtifactPath(changeRoot, path) };
      });
      for (const required of ["proposal.md", "design.md", "tasks.md"]) {
        if (!seen.has(required)) {
          throw new HarnessError("PLANNING_ARTIFACT_INVALID", `Planning synthesis omitted ${required}`, { required });
        }
      }
      if (![...seen].some((path) => path.startsWith("specs/") && path.endsWith("/spec.md"))) {
        throw new HarnessError("PLANNING_ARTIFACT_INVALID", "Planning synthesis omitted capability specifications");
      }
      for (const artifact of prepared) {
        await mkdir(resolve(artifact.destination, ".."), { recursive: true });
        await writeFile(
          artifact.destination,
          artifact.content.endsWith("\n") ? artifact.content : `${artifact.content}\n`,
          "utf8",
        );
      }
    },
  };

  const affectedFiles = preflight.evidence.map(({ path }) => path);
  const complexity = classifyChange({
    affectedFiles,
    affectedCapabilities: affectedFiles.map(affectedCapability).filter((value): value is string => Boolean(value)),
    hasPublicContractChange: /\b(?:public contract|api|schema|protocol)\b/i.test(effectivePrompt),
    hasDataMigration: /\bmigrat(?:e|ion)\b/i.test(effectivePrompt),
    hasSecurityBoundaryChange: /\b(?:security|permission|auth)\b/i.test(effectivePrompt),
    hasDesignAmbiguity: options.phase === "refine" && /\b(?:ambiguous|trade-?off|uncertain)\b/i.test(effectivePrompt),
  });
  const input = {
    changeName: options.changeName,
    prompt: effectivePrompt || `${options.phase} ${options.changeName}`,
    complexity,
    optionalBudgetAvailable: true,
    authoritativeContext: { status, changeRoot, preflight },
  };
  const planningDependencies = { ...dependencies, budget, budgetEstimates };
  const result = options.phase === "propose"
    ? await propose(input, planningDependencies)
    : await refine(input, planningDependencies);
  return {
    status: "success",
    action: options.phase,
    changeName: options.changeName,
    runId: planningRunId,
    summary: `${options.phase} completed with ${result.policy.classification} orchestration; OpenSpec artifacts were written.`,
    next: `/change review ${options.changeName}`,
  };
}
