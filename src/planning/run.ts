import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelSlot, ModelStack } from "../agents/model-stack.ts";
import type { AgentRun } from "../agents/run-record.ts";
import type { retrieveCandidates } from "../context/candidates.ts";
import { composePreflight, STANDARD_ALREADY_SATISFIED_QUESTION } from "../controller/preflight-composition.ts";
import { propose, refine, type PlanningAgentRequest, type PlanningAgentStage } from "../controller/planning.ts";
import { readLane, type Lane } from "../controller/lane.ts";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import type { OpenSpecAdapter } from "../openspec/adapter.ts";
import { FUSION_DRIVEN_SCHEMA_NAME } from "../openspec/fusion-driven-schema.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { parseReviewArtifact } from "../review/review-artifact.ts";
import { HarnessError } from "../shared/errors.ts";
import { readFileOrNull } from "../shared/fs.ts";
import type { BudgetAmount, BudgetLedger } from "../telemetry/budget.ts";
import { COMMAND_PROFILES } from "../tools/command-profile.ts";
import { formatPlanErrors, parsePlan, type Plan, type PlanError } from "./plan-schema.ts";
import { normalizePlan } from "./normalize.ts";
import { validatePlan } from "./plan-validate.ts";
import { renderRequiredChanges, type CurrentArtifact, type PlanningPromptInput } from "./prompts.ts";
import { renderArtifacts, writeArtifacts } from "./render.ts";
import { runPlanningSession, type PlanningSessionOptions } from "./session.ts";
import { reconcileDisposition, triageAndChooseLane } from "./triage.ts";

export interface PlanningRunOptions {
  cwd: string;
  changeName: string;
  phase: "propose" | "refine";
  runId: string;
  /** The request as the user typed it; empty for a bare refine. */
  prompt: string;
  /** A lane the user chose with `lane=`. */
  lane?: Lane;
  signal?: AbortSignal;
  onAgentStart?: (run: AgentRun) => void;
  openSpec: OpenSpecAdapter;
  stack: ModelStack;
  budget: BudgetLedger;
  budgetEstimates: Readonly<Record<PlanningAgentStage, BudgetAmount>>;
  judgment: JudgmentRuntime;
  usageStore: AtomicJsonStore;
  /** Test seams: candidate retrieval, the planning session, and installing the OpenSpec schema. */
  retrieve?: typeof retrieveCandidates;
  session?: typeof runPlanningSession;
  ensureSchema?: () => Promise<void>;
}

export type PlanningRunResult =
  | { kind: "blocked"; summary: string; question: string }
  /** `notes` lists the tasks that were merged, so the plan explains itself. */
  | { kind: "planned"; lane: Lane; notes: readonly string[] };

const blocked = (summary: string, evidence: readonly { path: string; reason: string }[], question: string): PlanningRunResult => ({
  kind: "blocked",
  summary: `${summary}\n\nEvidence:\n${evidence.map(({ path, reason }) => `- ${path}: ${reason}`).join("\n")}`,
  question,
});

/** A revising review's required changes, so a bare `/change refine` has something to go on. */
async function requiredChangesOf(changeRoot: string): Promise<string | undefined> {
  const path = resolve(changeRoot, "review.md");
  const contents = await readFileOrNull(path);
  if (!contents) return undefined;
  const review = parseReviewArtifact(contents, path);
  return review.verdict === "REVISE" ? renderRequiredChanges(review) : undefined;
}

/** The change's artifacts as they stand, for a refinement to revise. */
async function currentArtifacts(changeRoot: string): Promise<CurrentArtifact[]> {
  const names = ["proposal.md", "design.md", "tasks.md"];
  const specs = await readdir(join(changeRoot, "specs")).catch(() => [] as string[]);
  const found: CurrentArtifact[] = [];
  for (const path of [...names, ...specs.sort().map((name) => `specs/${name}/spec.md`)]) {
    const content = await readFileOrNull(resolve(changeRoot, path));
    if (content !== null) found.push({ path, content });
  }
  return found;
}

function checkPlan(text: string): { ok: true; plan: Plan } | { ok: false; errors: readonly PlanError[] } {
  const parsed = parsePlan(text);
  if (!parsed.ok) return parsed;
  if (parsed.plan.disposition !== "plan") return parsed;
  const errors = validatePlan(parsed.plan, { verificationProfile: COMMAND_PROFILES.verification! });
  return errors.length > 0 ? { ok: false, errors } : parsed;
}

const slotFor = (stack: ModelStack, request: PlanningAgentRequest): ModelSlot =>
  request.stage === "specialist_opinion" && stack.builders.length > 0
    ? stack.builders[(request.opinionIndex ?? 0) % stack.builders.length]!
    : stack.architect;

async function ensureChange(options: PlanningRunOptions): Promise<void> {
  try {
    await options.openSpec.status(options.changeName);
  } catch (error) {
    if (!(error instanceof HarnessError) || error.code !== "OPENSPEC_COMMAND_FAILED") throw error;
    await options.ensureSchema?.();
    await options.openSpec.createChange(options.changeName, options.prompt || `Plan ${options.changeName}`, FUSION_DRIVEN_SCHEMA_NAME);
  }
}

/**
 * Plans a change: choose the lane, then one plan session (after opinions and a debate on large),
 * validate the plan in code with one specific retry, and render every artifact from it. A
 * clarification or already-satisfied answer ends the run without writing anything.
 */
export async function runPlanning(options: PlanningRunOptions): Promise<PlanningRunResult> {
  const { openSpec: adapter, changeName, phase } = options;
  const early = phase === "refine" ? await adapter.status(changeName) : undefined;
  const requiredChanges = early ? await requiredChangesOf(resolve(early.changeRoot)) : undefined;
  const request = requiredChanges ? (options.prompt ? `${options.prompt}\n\n${requiredChanges}` : requiredChanges) : options.prompt;

  const triage = await triageAndChooseLane({
    runtime: options.judgment,
    store: options.usageStore,
    cwd: options.cwd,
    changeName,
    phase,
    request,
    userLane: options.lane,
    retrieve: options.retrieve,
    signal: options.signal,
  });
  const { choice, candidates, verdict, triaged } = triage;
  if (verdict && triaged?.disposition === "already_satisfied") {
    const composed = composePreflight({ ...triaged, disposition: "already_satisfied" }, candidates);
    await reconcileDisposition({ verdict, candidates, producedBy: "judgment" });
    return blocked(composed.summary, composed.evidence, STANDARD_ALREADY_SATISFIED_QUESTION);
  }

  const context = { changeName, phase, lane: choice.lane, candidatePaths: candidates.map(({ path }) => path) };
  const base: PlanningPromptInput = {
    changeName,
    request: options.prompt,
    lane: choice.lane,
    authoritativeContext: context,
    currentArtifacts: early ? await currentArtifacts(resolve(early.changeRoot)) : undefined,
    requiredChanges,
    triageProceeds: triaged?.disposition === "proceed",
  };
  const sessionOptions: Omit<PlanningSessionOptions, "slot"> = {
    cwd: options.cwd,
    changeName,
    phase,
    runId: options.runId,
    stack: options.stack,
    classification: choice.complexity.classification,
    usageStore: options.usageStore,
    budget: options.budget,
    onAgentStart: options.onAgentStart,
    signal: options.signal,
  };
  const session = options.session ?? runPlanningSession;
  const result = await (phase === "propose" ? propose : refine)({
    changeName,
    prompt: request || `${phase} ${changeName}`,
    lane: choice.lane,
    complexity: choice.complexity,
    optionalBudgetAvailable: true,
    authoritativeContext: context,
  }, {
    budget: options.budget,
    budgetEstimates: options.budgetEstimates,
    async runAgent(stage) {
      const slot = slotFor(options.stack, stage);
      const kind = stage.stage === "synthesis" ? "plan" : stage.stage === "debate" ? "debate" : "opinion";
      const content = await session(kind, { ...base, priorAnalysis: stage.priorResults }, { ...sessionOptions, slot });
      return { model: slot.model, content };
    },
  });

  // One retry, with the specific failures, when the plan does not parse or validate.
  let checked = checkPlan(result.synthesis.content);
  if (!checked.ok) {
    const analysis = [...result.opinions, ...(result.debate ? [result.debate] : [])];
    const retried = await session(
      "plan",
      { ...base, priorAnalysis: analysis, validationFailures: formatPlanErrors(checked.errors) },
      { ...sessionOptions, slot: options.stack.architect },
    );
    checked = checkPlan(retried);
    if (!checked.ok) {
      throw new HarnessError(
        "PLANNING_ARTIFACT_INVALID",
        `The plan is still invalid after one retry:\n${formatPlanErrors(checked.errors)}`,
        { errors: checked.errors },
      );
    }
  }
  const plan = checked.plan;
  if (verdict) {
    await reconcileDisposition({
      verdict,
      candidates,
      producedBy: triaged?.disposition ? "judgment" : "agent",
      agent: plan.disposition === "plan"
        ? { disposition: "proceed", evidencePaths: [] }
        : { disposition: plan.disposition, evidencePaths: plan.evidence.map(({ path }) => path) },
    });
  }
  if (plan.disposition === "needs_clarification") return blocked(plan.summary, plan.evidence, plan.question);
  if (plan.disposition === "already_satisfied") {
    return blocked(plan.summary, plan.evidence, plan.question ?? STANDARD_ALREADY_SATISFIED_QUESTION);
  }

  if (phase === "propose") await ensureChange(options);
  const status = early ?? await adapter.status(changeName);
  const { plan: normalized, notes } = normalizePlan(plan);
  await writeArtifacts(renderArtifacts(normalized, resolve(status.changeRoot)));
  await verdict?.reconcile({ laneHeld: (await readLane(options.usageStore, changeName)).lane === choice.lane });
  return { kind: "planned", lane: choice.lane, notes };
}
