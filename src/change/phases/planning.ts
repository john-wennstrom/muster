import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  type ModelSlot,
  type ModelStack,
  type Thinking,
} from "../../agents/model-stack.ts";
import { newRun, runError, runOk } from "../../agents/run-record.ts";
import { runAgent as runChildAgent } from "../../agents/spawn.ts";
import {
  propose,
  refine,
  type PlanningAgentRequest,
  type PlanningAgentResult,
  type PlanningArtifactWriteRequest,
  type PlanningPhase,
} from "../../controller/planning.ts";
import { classifyChange } from "../../controller/complexity-router.ts";
import {
  bindTaskQualityRecord,
  buildTaskQualityInput,
  type TaskQualityBundleArtifact,
} from "../../controller/task-quality.ts";
import {
  mergeRiskInputs,
  patternRiskInputs,
  type RiskInputs,
} from "../../controller/complexity-inputs.ts";
import { retrieveCandidates, type Candidate } from "../../context/candidates.ts";
import {
  composePreflight,
  STANDARD_ALREADY_SATISFIED_QUESTION,
} from "../../controller/preflight-composition.ts";
import { createJudgmentRuntime, type JudgmentRuntime, type JudgmentVerdict } from "../../judgment/ask.ts";
import { reconcileDecisionRecord } from "../../judgment/audit.ts";
import {
  COMPLEXITY_SIGNALS,
  complexityState,
  planningComplexityDecision,
  planningPreflightDecision,
  planningTaskQualityDecision,
  preflightCandidateAnswers,
  preflightState,
  presentTaskQualityFindings,
  PREFLIGHT_RELEVANCE_FLOOR,
  taskQualityState,
  type PreflightGateValue,
} from "../../judgment/gates.ts";
import { PREFLIGHT_QUESTION_IDS } from "../../judgment/questions.ts";
import { JudgmentFixtureMissingError } from "../../judgment/replay.ts";
import { OpenSpecAdapter } from "../../openspec/adapter.ts";
import {
  CORE_PLANNING_ARTIFACT_IDS,
  ensureFusionDrivenSchemaInstalled,
  FUSION_DRIVEN_SCHEMA_NAME,
} from "../../openspec/fusion-driven-schema.ts";
import type { OpenSpecInstructions, OpenSpecStatus } from "../../openspec/protocol.ts";
import type { AtomicJsonStore } from "../../persistence/atomic-json-store.ts";
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
  /**
   * Files that code retrieved, listed in the agent's prompt. Present only when judgment
   * answered and did not act in enforce mode; every other path leaves it unset so the
   * prompt is exactly what it is without judgment.
   */
  candidates?: readonly Candidate[];
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

function candidatesSection(candidates: readonly Candidate[]): string {
  return [
    "Candidate files found by a deterministic code search of the repository. They are starting points, not a complete or authoritative list; use your read/search calls to confirm or look further.",
    ...candidates.map((candidate) => [
      `- ${candidate.path} (matched: ${candidate.matchedTerms.join(", ")})`,
      ...candidate.excerpt.split("\n").map((line) => `    ${line}`),
    ].join("\n")),
  ].join("\n");
}

export function preflightPrompt(request: PlanningPreflightRequest): string {
  const sections = [
    "Determine whether the requested change is needed in the checked-out repository.",
    `Change: ${request.changeName}`,
    `User request: ${request.prompt}`,
    `Use at most ${PREFLIGHT_MAX_TOOL_CALLS} read/search calls. Follow the nearest controlling code path only.`,
    "Stop as soon as file evidence distinguishes proceed, needs_clarification, or already_satisfied.",
    "If checked-out behavior already satisfies the request, do not invent adjacent improvements; return already_satisfied and ask which branch, deployment, or entry point still fails.",
    "If ambiguity prevents a bounded proposal, return needs_clarification with one specific question.",
    "Return exactly one JSON object: {\"disposition\":\"proceed|needs_clarification|already_satisfied\",\"summary\":\"...\",\"evidence\":[{\"path\":\"repo/relative/path\",\"reason\":\"...\"}],\"question\":\"...\"}. Omit the \"question\" field entirely unless disposition is \"needs_clarification\" — do not include it as an empty string.",
  ];
  // The output contract stays last; candidates go before it.
  if (request.candidates?.length) sections.splice(-1, 0, candidatesSection(request.candidates));
  return sections.join("\n\n");
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

/**
 * Determines the four risk inputs to complexity classification. The pattern values are the
 * baseline and the answer for every case judgment does not act on: disabled, shadow mode,
 * unavailable, or not confident. Only a confident enforce-mode answer replaces a pattern
 * value, one input at a time. Each record is reconciled with the pattern values so the two
 * can be compared across real changes; that bookkeeping never affects planning.
 */
async function resolveRiskInputs(input: {
  runtime: JudgmentRuntime;
  store: AtomicJsonStore;
  changeName: string;
  phase: PlanningPhase;
  prompt: string;
  evidence: PlanningPreflight["evidence"];
  signal?: AbortSignal;
}): Promise<RiskInputs> {
  const pattern = patternRiskInputs(input.prompt, input.phase);
  const state = { request: input.prompt, phase: input.phase, evidence: input.evidence };
  const verdict = await input.runtime.judge(planningComplexityDecision, {
    input: state,
    changeName: input.changeName,
    phase: "planning",
    state: complexityState(state),
    sourcePaths: input.evidence.map(({ path }) => path),
    signal: input.signal,
  });
  const applied = verdict.kind === "enforce" && verdict.outcome.act
    ? mergeRiskInputs(pattern, verdict.outcome.value, input.phase)
    : pattern;
  if (verdict.recordId) {
    try {
      const observed = await reconcileDecisionRecord(input.store, input.changeName, verdict.recordId, {
        observed: { ...pattern, applied, planningPhase: input.phase },
      });
      const judged = observed.found && observed.record.gate?.act ? observed.record.gate.value : null;
      if (judged && typeof judged === "object" && !Array.isArray(judged)) {
        const agreed = COMPLEXITY_SIGNALS.every(([key]) => {
          const value = judged[key];
          return typeof value !== "boolean" || value === pattern[key];
        });
        await reconcileDecisionRecord(input.store, input.changeName, verdict.recordId, { agreed });
      }
    } catch {
      // Reconciliation is measurement; a failure to write it must not fail planning.
    }
  }
  return applied;
}

interface JudgedPreflight {
  readonly verdict: JudgmentVerdict<PreflightGateValue>;
  readonly candidates: readonly Candidate[];
}

/**
 * Retrieves candidates and asks the preflight question. `null` means judgment played no part —
 * it is disabled, or retrieval or the call failed — and preflight runs the agent exactly as it
 * does without judgment. An operational failure here must never fail preflight.
 */
async function judgePreflight(input: {
  runtime: JudgmentRuntime;
  retrieve: typeof retrieveCandidates;
  cwd: string;
  changeName: string;
  prompt: string;
  avoided: BudgetAmount;
  signal?: AbortSignal;
}): Promise<JudgedPreflight | null> {
  if (!input.runtime.enabled) return null;
  try {
    const candidates = await input.retrieve({ cwd: input.cwd, request: input.prompt, signal: input.signal });
    const preflightInput = { request: input.prompt, candidates };
    const verdict = await input.runtime.judge(planningPreflightDecision, {
      input: preflightInput,
      changeName: input.changeName,
      phase: "planning",
      state: preflightState(preflightInput),
      sourcePaths: candidates.map(({ path }) => path),
      signal: input.signal,
      avoided: { activity: "preflight", ...input.avoided },
    });
    return { verdict, candidates };
  } catch (error) {
    // A missing recording is a test failure, not an outage; converting it would hide it.
    if (error instanceof JudgmentFixtureMissingError) throw error;
    return null;
  }
}

/**
 * Records which path produced the preflight. In shadow mode the agent ran exactly as it does
 * without judgment, so its disposition is the counterfactual: the record also gets the agent's
 * disposition and evidence paths, and whether the judged disposition agreed. In enforce mode
 * the agent saw the candidates, so its answer is not independent and agreement is left unset.
 * This is measurement; a failure to write it must not fail planning.
 */
async function reconcilePreflight(input: {
  store: AtomicJsonStore;
  changeName: string;
  judged: JudgedPreflight;
  producedBy: "judgment" | "agent";
  agent?: PlanningPreflight;
}): Promise<void> {
  const { recordId } = input.judged.verdict;
  if (!recordId) return;
  try {
    const observed: Record<string, string | string[]> = { producedBy: input.producedBy };
    const agentPaths = input.agent?.evidence.map(({ path }) => path) ?? [];
    if (input.agent) {
      observed.agentDisposition = input.agent.disposition;
      observed.agentEvidencePaths = agentPaths;
    }
    const result = await reconcileDecisionRecord(input.store, input.changeName, recordId, { observed });
    if (input.judged.verdict.kind !== "shadow" || !input.agent || !result.found || !result.record.answers) return;
    const answers = result.record.answers;
    const judgedAnswer = answers[PREFLIGHT_QUESTION_IDS.disposition];
    const judgedRelevantPaths = preflightCandidateAnswers(answers)
      .filter(({ relevance }) => relevance >= PREFLIGHT_RELEVANCE_FLOOR)
      .map(({ index }) => input.judged.candidates[index - 1]?.path)
      .filter((path): path is string => path !== undefined);
    await reconcileDecisionRecord(input.store, input.changeName, recordId, {
      observed: {
        judgedRelevantPaths,
        evidenceOverlap: judgedRelevantPaths.filter((path) => agentPaths.includes(path)).length,
      },
      agreed: judgedAnswer?.type === "choice" && judgedAnswer.choice === input.agent.disposition,
    });
  } catch {
    // Reconciliation is measurement; a failure to write it must not fail planning.
  }
}

interface TaskQualityFindings {
  readonly total: number;
  readonly lines: readonly string[];
}

/** One question per property per task is a long request; planning runs for minutes, so this waits longer than a hot path. */
const TASK_QUALITY_DEADLINE_MS = 30_000;

/**
 * Assesses a synthesized task list once, over the artifacts about to be written. The findings
 * are advice: the caller writes exactly what it would write without them, and only an
 * enforce-mode assessment returns findings for the outcome. Shadow mode records and returns
 * nothing. `null` means judgment played no part: it is disabled, the task list does not parse
 * or validate, the list is over the cap, the call was unavailable, or anything failed here.
 */
async function assessTaskQuality(input: {
  runtime: JudgmentRuntime;
  store: AtomicJsonStore;
  changeName: string;
  artifacts: readonly TaskQualityBundleArtifact[];
  signal?: AbortSignal;
}): Promise<TaskQualityFindings | null> {
  if (!input.runtime.enabled) return null;
  try {
    const built = buildTaskQualityInput(input.artifacts);
    if (!built.ok) return null;
    const verdict = await input.runtime.judge(planningTaskQualityDecision, {
      input: built.input,
      changeName: input.changeName,
      phase: "planning",
      state: taskQualityState(built.input),
      signal: input.signal,
      deadlineMs: TASK_QUALITY_DEADLINE_MS,
    });
    if (verdict.kind === "fallback") return null;
    if (verdict.recordId) {
      try {
        await bindTaskQualityRecord(input.store, input.changeName, verdict.recordId, built);
      } catch {
        // Binding is what lets a finding be shown later; without it nothing is shown or reconciled.
      }
    }
    if (verdict.kind !== "enforce" || !verdict.outcome.act) return null;
    const presented = presentTaskQualityFindings(verdict.outcome.value.findings, built.taskIds);
    return presented.total > 0 ? presented : null;
  } catch (error) {
    // A missing recording is a test failure, not an outage; converting it would hide it.
    if (error instanceof JudgmentFixtureMissingError) throw error;
    return null;
  }
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
  /** Replaces the runtime built from the environment; tests inject a replaying or dead client. */
  judgment?: JudgmentRuntime;
  /** Replaces candidate retrieval; tests inject a spy or a failure. */
  retrieve?: typeof retrieveCandidates;
  budgetEstimates?: Partial<Record<"preflight" | PlanningAgentRequest["stage"], BudgetAmount>>;
  runPreflight?(request: PlanningPreflightRequest, slot: ModelSlot): Promise<PlanningPreflight>;
  runAgent?(request: PlanningAgentRequest, status: OpenSpecStatus, slot: ModelSlot): Promise<PlanningAgentResult>;
  ensureSchema?(): Promise<void>;
}

/** Lists the findings, or nothing: the outcome without findings reads exactly as it does without judgment. */
function taskQualitySummary(findings: TaskQualityFindings | null): string {
  if (!findings) return "";
  const noun = findings.total === 1 ? "finding" : "findings";
  const more = findings.total > findings.lines.length ? [`- ${findings.total - findings.lines.length} more not listed`] : [];
  return [
    `\n\nTask quality: ${findings.total} advisory ${noun} from an automated check of the task list; the plan review confirms or dismisses them.`,
    ...findings.lines.map((line) => `- ${line}`),
    ...more,
  ].join("\n");
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
      await runChildAgent({
        access: "read",
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

  const judgment = options.judgment ?? createJudgmentRuntime({ env: process.env, store: usageStore, budget });
  // Runs the agent, after the mandatory budget forecast; skipped entirely when judgment acts.
  const runPreflightAgent = async (request: PlanningPreflightRequest): Promise<PlanningPreflight> => {
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
    return options.runPreflight
      ? options.runPreflight(request, stack.architect)
      : parsePreflight(await runChild({
        prompt: preflightPrompt(request),
        slot: stack.architect,
        stage: "preflight",
        thinking: "low",
        boundedDiscovery: true,
      }));
  };
  const judged = await judgePreflight({
    runtime: judgment,
    retrieve: options.retrieve ?? retrieveCandidates,
    cwd: options.cwd,
    changeName: options.changeName,
    prompt: effectivePrompt,
    avoided: budgetEstimates.preflight,
    signal: options.signal,
  });
  const verdict = judged?.verdict;
  const acted = verdict?.kind === "enforce" && verdict.outcome.act ? verdict.outcome.value : null;
  let preflight: PlanningPreflight;
  if (judged && acted) {
    preflight = composePreflight(acted, judged.candidates);
    await reconcilePreflight({ store: usageStore, changeName: options.changeName, judged, producedBy: "judgment" });
  } else {
    // Candidates are pre-loaded only when judgment answered in enforce mode and did not act.
    // Unavailable judgment and shadow mode run the agent with today's prompt.
    preflight = await runPreflightAgent({
      changeName: options.changeName,
      prompt: effectivePrompt,
      ...(verdict?.kind === "enforce" && judged!.candidates.length > 0
        ? { candidates: judged!.candidates }
        : {}),
    });
    if (judged) {
      await reconcilePreflight({
        store: usageStore,
        changeName: options.changeName,
        judged,
        producedBy: "agent",
        agent: preflight,
      });
    }
  }
  if (preflight.disposition !== "proceed") {
    const question = preflight.question ?? STANDARD_ALREADY_SATISFIED_QUESTION;
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

  const taskQuality: { current: TaskQualityFindings | null } = { current: null };
  const dependencies = {
    runAgent: (request: PlanningAgentRequest) => runAgent(request, status, slotForRequest(stack, request)),
    async writeArtifacts(request: PlanningArtifactWriteRequest) {
      taskQuality.current = null;
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
      taskQuality.current = await assessTaskQuality({
        runtime: judgment,
        store: usageStore,
        changeName: options.changeName,
        artifacts: bundle.artifacts,
        signal: options.signal,
      });
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
  const riskInputs = await resolveRiskInputs({
    runtime: judgment,
    store: usageStore,
    changeName: options.changeName,
    phase: options.phase,
    prompt: effectivePrompt,
    evidence: preflight.evidence,
    signal: options.signal,
  });
  const complexity = classifyChange({
    affectedFiles,
    affectedCapabilities: affectedFiles.map(affectedCapability).filter((value): value is string => Boolean(value)),
    ...riskInputs,
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
    summary: `${options.phase} completed with ${result.policy.classification} orchestration; OpenSpec artifacts were written.${taskQualitySummary(taskQuality.current)}`,
    next: `/change review ${options.changeName}`,
  };
}
