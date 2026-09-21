import { z } from "zod";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { changeRunId } from "../persistence/change-usage-store.ts";
import { HarnessError } from "../shared/errors.ts";
import { classifyChange, type ChangeComplexity, type ComplexityDecision, type ComplexityInput } from "./complexity-router.ts";
import { mergeRiskInputs, type JudgedRiskInputs, type RiskInputs } from "./complexity-inputs.ts";
import type { PlanningPhase } from "./planning.ts";

/**
 * The size of a change, decided once before any agent runs. Small work gets the least ceremony,
 * large work the most, and a lane only ever moves up. Every lane keeps the deterministic gates;
 * a lane removes model sessions, never checks.
 */

export const LANES = ["small", "medium", "large"] as const;
export type Lane = (typeof LANES)[number];

export type LaneSource = "user" | "judgment" | "pattern";

/** Everything that depends on a lane, in one place. Later changes add fields here, not switches elsewhere. */
export const LANE_POLICY = {
  small: { specialistOpinions: 0, debate: false, reducesWorkAllowed: true, planReview: "lint", maxTasks: 2, allowManualTasks: false },
  medium: { specialistOpinions: 0, debate: false, reducesWorkAllowed: true, planReview: "reviewer", maxTasks: 40, allowManualTasks: true },
  large: { specialistOpinions: 2, debate: true, reducesWorkAllowed: false, planReview: "reviewer", maxTasks: 40, allowManualTasks: true },
} as const satisfies Record<Lane, {
  specialistOpinions: number;
  debate: boolean;
  reducesWorkAllowed: boolean;
  /** Who approves a plan: a deterministic lint plus a semantic check, or an independent reviewer. */
  planReview: "lint" | "reviewer";
  maxTasks: number;
  allowManualTasks: boolean;
}>;

export const isLane = (value: unknown): value is Lane =>
  typeof value === "string" && (LANES as readonly string[]).includes(value);

const rank = (lane: Lane): number => LANES.indexOf(lane);

/** Direct and bounded work is medium, because a pattern over the request is too weak to justify doing less. */
export function laneOfClassification(classification: ChangeComplexity): Lane {
  return classification === "architectural" ? "large" : "medium";
}

/** The highest level of the reach rubric that still counts as small: one file, or one module. */
export const SMALL_REACH_AT_MOST = 1;

/** What triage judged confidently. An absent field is uncertain. */
export interface JudgedTriage {
  /** Only the risk inputs judged with confidence. */
  readonly risks: JudgedRiskInputs;
  /** The confidently judged reach level, zero (one function or file) to three (outside the repository). */
  readonly reach?: number;
}

export interface LaneChoiceInput {
  /** The classification inputs computed from candidate paths and the request patterns. */
  readonly pattern: ComplexityInput;
  readonly judged?: JudgedTriage | null;
  readonly phase: PlanningPhase;
  /** An explicit `lane=` from the user, which wins over everything. */
  readonly userLane?: Lane;
}

export interface LaneChoice {
  readonly lane: Lane;
  readonly source: LaneSource;
  readonly reasons: readonly string[];
  /** The classification behind the lane, after the judged risk answers were merged. */
  readonly complexity: ComplexityDecision;
}

const CLASSIFICATION_OF_LANE: Record<Lane, ChangeComplexity> = {
  small: "direct",
  medium: "bounded",
  large: "architectural",
};

const RISKS: readonly (readonly [keyof RiskInputs, string])[] = [
  ["hasPublicContractChange", "public contract"],
  ["hasDataMigration", "data migration"],
  ["hasSecurityBoundaryChange", "security boundary"],
  ["hasDesignAmbiguity", "design ambiguity"],
];

/**
 * Chooses the lane. The pattern lane is the floor: judged answers replace one risk input at a
 * time when confident, and small is reachable only when every risk and the reach were judged
 * with confidence and the resulting classification is direct. Anything uncertain leaves the lane
 * where the pattern and the confident answers put it.
 */
export function chooseLane(input: LaneChoiceInput): LaneChoice {
  if (input.userLane) {
    const reason = `the user chose lane=${input.userLane}`;
    return {
      lane: input.userLane,
      source: "user",
      reasons: [reason],
      complexity: classifyChange(input.pattern, {
        classification: CLASSIFICATION_OF_LANE[input.userLane],
        reason,
        actor: "user",
      }),
    };
  }
  const patternDecision = classifyChange(input.pattern);
  const patternLane = laneOfClassification(patternDecision.classification);
  const reasons = [`pattern classification ${patternDecision.classification} gives ${patternLane}`];
  const risks = input.judged?.risks ?? {};

  const merged = mergeRiskInputs(input.pattern, risks, input.phase);
  const mergedDecision = classifyChange({ ...input.pattern, ...merged });
  let lane = laneOfClassification(mergedDecision.classification);
  for (const [key, label] of RISKS) {
    if (risks[key] !== undefined && merged[key] !== input.pattern[key]) {
      reasons.push(`judged ${label} as ${merged[key] ? "yes" : "no"} with confidence, replacing the pattern value`);
    }
  }
  if (lane !== patternLane) reasons.push(`the judged answers move the classification to ${mergedDecision.classification}, giving ${lane}`);

  const everyRiskJudgedNo = RISKS.every(([key]) => risks[key] === false);
  const reach = input.judged?.reach;
  if (
    lane === "medium"
    && mergedDecision.classification === "direct"
    && everyRiskJudgedNo
    && reach !== undefined
    && reach <= SMALL_REACH_AT_MOST
  ) {
    lane = "small";
    reasons.push(`every risk was judged no and reach ${reach} is within one module, on a direct classification`);
  } else if (lane === "medium" && mergedDecision.classification === "direct") {
    reasons.push("small needs every risk and the reach judged with confidence, so the lane stays medium");
  }
  return { lane, source: lane === patternLane ? "pattern" : "judgment", reasons, complexity: mergedDecision };
}

export const laneRecordSchema = z.object({
  schemaVersion: z.literal(1),
  lane: z.enum(LANES),
  source: z.enum(["user", "judgment", "pattern"]),
  reasons: z.array(z.string()),
  /** In shadow mode, the lane enforce mode would have chosen; the lane itself is the pattern lane. */
  shadowLane: z.enum(LANES).optional(),
  escalations: z.array(z.object({
    from: z.enum(LANES),
    to: z.enum(LANES),
    reason: z.string().min(1),
    at: z.string(),
  }).strict()),
  decidedAt: z.string(),
}).strict();

export type LaneRecord = z.infer<typeof laneRecordSchema>;

const LANE_RECORD_PATH = "lane.json";

const DEFAULT_LANE_RECORD: LaneRecord = {
  schemaVersion: 1,
  lane: "medium",
  source: "pattern",
  reasons: ["no lane was recorded for this change, so it is treated as medium"],
  escalations: [],
  decidedAt: "",
};

/** The change's lane record, or medium when none was ever written (a change planned before lanes existed). */
export async function readLane(store: AtomicJsonStore, changeName: string): Promise<LaneRecord> {
  try {
    return laneRecordSchema.parse(await store.read(changeRunId(changeName), LANE_RECORD_PATH));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_LANE_RECORD;
    throw error;
  }
}

export async function writeLane(
  store: AtomicJsonStore,
  changeName: string,
  choice: Pick<LaneChoice, "lane" | "source" | "reasons"> & { readonly shadowLane?: Lane },
  now: () => Date = () => new Date(),
): Promise<LaneRecord> {
  const record: LaneRecord = {
    schemaVersion: 1,
    lane: choice.lane,
    source: choice.source,
    reasons: [...choice.reasons],
    ...(choice.shadowLane ? { shadowLane: choice.shadowLane } : {}),
    escalations: [],
    decidedAt: now().toISOString(),
  };
  await store.write(changeRunId(changeName), LANE_RECORD_PATH, record);
  return record;
}

/** Moves the change to a strictly higher lane and appends the move to its history. */
export async function escalateLane(
  store: AtomicJsonStore,
  changeName: string,
  to: Lane,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<LaneRecord> {
  const current = await readLane(store, changeName);
  if (rank(to) <= rank(current.lane)) {
    throw new HarnessError(
      "LANE_TRANSITION_INVALID",
      `A change on the ${current.lane} lane cannot move to ${to}: lanes only escalate`,
      { changeName, from: current.lane, to },
    );
  }
  if (!reason.trim()) {
    throw new HarnessError("LANE_TRANSITION_INVALID", "A lane escalation needs a reason", { changeName, to });
  }
  const record: LaneRecord = {
    ...current,
    lane: to,
    escalations: [...current.escalations, { from: current.lane, to, reason: reason.trim(), at: now().toISOString() }],
    decidedAt: current.decidedAt || now().toISOString(),
  };
  await store.write(changeRunId(changeName), LANE_RECORD_PATH, record);
  return record;
}
