import { retrieveCandidates, type Candidate } from "../context/candidates.ts";
import { chooseLane, writeLane, type JudgedTriage, type Lane, type LaneChoice } from "../controller/lane.ts";
import { mergeRiskInputs, patternRiskInputs, type RiskInputs } from "../controller/complexity-inputs.ts";
import type { PlanningPhase } from "../controller/planning.ts";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import {
  changeTriageDecision,
  triageCandidateAnswers,
  triageState,
  TRIAGE_RELEVANCE_FLOOR,
  TRIAGE_RISK_QUESTIONS,
  type TriageGateValue,
} from "../judgment/decisions/change-triage.ts";
import { TRIAGE_QUESTION_IDS } from "../judgment/questions.ts";
import { tryJudge, type TriedVerdict } from "../judgment/try.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";

/** The front of planning: candidates by code, one triage request, the pattern floor, and the lane record. */

export interface TriageOutcome {
  readonly choice: LaneChoice;
  readonly candidates: readonly Candidate[];
  /** Null when judgment played no part: disabled, unavailable, or an explicit lane. */
  readonly verdict: TriedVerdict<TriageGateValue> | null;
  /** The gate value, only when it was handed over: enforce mode, and the gate acted. */
  readonly triaged: TriageGateValue | null;
}

export function affectedCapability(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const match = normalized.match(/(?:^|\/)features\/([^/]+)\//) ?? normalized.match(/(?:^|\/)src\/([^/]+)\//);
  return match?.[1];
}

/** Retrieves candidate files by code, with or without judgment. A failure leaves the request with none. */
async function retrieve(
  retrieveFiles: typeof retrieveCandidates,
  input: Parameters<typeof retrieveCandidates>[0],
): Promise<readonly Candidate[]> {
  try {
    return await retrieveFiles(input);
  } catch {
    return [];
  }
}

const judgedTriage = (value: TriageGateValue): JudgedTriage => ({ risks: value.risks, reach: value.reach });

/**
 * Chooses the lane before any agent runs and records it: retrieve candidates, ask triage once
 * unless the user chose the lane, classify with the patterns as the floor, and write `lane.json`.
 * In shadow mode the pattern lane is used and the lane enforce mode would have chosen is recorded.
 */
export async function triageAndChooseLane(input: {
  runtime: JudgmentRuntime;
  store: AtomicJsonStore;
  cwd: string;
  changeName: string;
  phase: PlanningPhase;
  /** The request, with a revising review's required changes when refining. */
  request: string;
  userLane?: Lane;
  retrieve?: typeof retrieveCandidates;
  signal?: AbortSignal;
}): Promise<TriageOutcome> {
  const candidates = await retrieve(input.retrieve ?? retrieveCandidates, {
    cwd: input.cwd,
    request: input.request,
    signal: input.signal,
  });
  const paths = candidates.map(({ path }) => path);
  const patternRisks = patternRiskInputs(input.request, input.phase);
  const pattern = {
    affectedFiles: paths,
    affectedCapabilities: paths.map(affectedCapability).filter((value): value is string => Boolean(value)),
    ...patternRisks,
  };
  const triageInput = { request: input.request, phase: input.phase, candidates };
  const verdict = input.userLane
    ? null
    : await tryJudge(input.runtime, changeTriageDecision, {
      input: triageInput,
      changeName: input.changeName,
      phase: "planning",
      state: triageState(triageInput),
      sourcePaths: paths,
      signal: input.signal,
    });
  const triaged = verdict?.kind === "enforce" && verdict.outcome.act ? verdict.outcome.value : null;
  const choice = chooseLane({
    pattern,
    judged: triaged ? judgedTriage(triaged) : null,
    phase: input.phase,
    userLane: input.userLane,
  });

  let shadowLane: Lane | undefined;
  if (verdict?.kind === "shadow") {
    const gate = (await verdict.reconcile())?.gate;
    if (gate?.act) {
      shadowLane = chooseLane({
        pattern,
        judged: judgedTriage(gate.value as unknown as TriageGateValue),
        phase: input.phase,
      }).lane;
    }
  }
  await writeLane(input.store, input.changeName, {
    lane: choice.lane,
    source: choice.source,
    reasons: choice.reasons,
    shadowLane,
  });
  if (verdict) {
    await verdict.reconcile({ lane: choice.lane, laneSource: choice.source, ...(shadowLane ? { shadowLane } : {}) });
    await reconcileRisks(verdict, patternRisks, mergeRiskInputs(patternRisks, triaged?.risks ?? {}, input.phase), input.phase);
  }
  return { choice, candidates, verdict, triaged };
}

/**
 * Records what triage was compared with: the pattern risk inputs, what was applied, and whether
 * the judged risks agreed with the patterns. Measurement only; it never affects planning.
 */
async function reconcileRisks(
  verdict: TriedVerdict<TriageGateValue>,
  pattern: RiskInputs,
  applied: RiskInputs,
  phase: PlanningPhase,
): Promise<void> {
  const record = await verdict.reconcile({ ...pattern, applied, planningPhase: phase });
  const judged = record?.gate?.act ? (record.gate.value as { risks?: unknown }).risks : null;
  if (!judged || typeof judged !== "object" || Array.isArray(judged)) return;
  const risks = judged as Record<string, unknown>;
  const agreed = TRIAGE_RISK_QUESTIONS.every(([key]) => {
    const value = risks[key];
    return typeof value !== "boolean" || value === pattern[key];
  });
  await verdict.reconcile({ risksAgreed: agreed }, agreed);
}

/**
 * Records which path decided the disposition. In shadow mode the planning session decided it as
 * it does without judgment, so its disposition is the counterfactual: the record also gets that
 * disposition and its evidence paths, and whether the judged disposition agreed. In enforce mode
 * the session saw the same candidates, so its answer is not independent and takes no part in the
 * agreement.
 */
export async function reconcileDisposition(input: {
  verdict: TriedVerdict<TriageGateValue>;
  candidates: readonly Candidate[];
  producedBy: "judgment" | "agent";
  agent?: { readonly disposition: string; readonly evidencePaths: readonly string[] };
}): Promise<void> {
  const { verdict, candidates } = input;
  const observed: Record<string, string | string[]> = { producedBy: input.producedBy };
  if (input.agent) {
    observed.agentDisposition = input.agent.disposition;
    observed.agentEvidencePaths = [...input.agent.evidencePaths];
  }
  const record = await verdict.reconcile(observed);
  if (verdict.kind !== "shadow" || !input.agent || !record?.answers) return;
  const judgedAnswer = record.answers[TRIAGE_QUESTION_IDS.disposition];
  const judgedRelevantPaths = triageCandidateAnswers(record.answers)
    .filter(({ relevance }) => relevance >= TRIAGE_RELEVANCE_FLOOR)
    .map(({ index }) => candidates[index - 1]?.path)
    .filter((path): path is string => path !== undefined);
  const dispositionAgreed = judgedAnswer?.type === "choice" && judgedAnswer.choice === input.agent.disposition;
  // The record has one agreement: the risks agreed with the patterns and the disposition with the session.
  await verdict.reconcile({
    judgedRelevantPaths,
    evidenceOverlap: judgedRelevantPaths.filter((path) => input.agent!.evidencePaths.includes(path)).length,
    dispositionAgreed,
  }, dispositionAgreed && record.observed.risksAgreed !== false);
}
