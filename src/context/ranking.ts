import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import { reconcileDecisionRecord } from "../judgment/audit.ts";
import {
  capsuleRankingState,
  contextCapsuleRankingDecision,
  type CapsuleRankingGateValue,
} from "../judgment/gates.ts";
import { JudgmentFixtureMissingError } from "../judgment/replay.ts";
import {
  assembleTaskCapsule,
  isDemotedByRanking,
  type AssembleTaskCapsuleOptions,
  type CapsuleRanking,
  type ContextSlice,
} from "./assembler.ts";
import { MAX_EXCERPT_BYTES, truncateBytes } from "./candidates.ts";

/**
 * The ranking step: ask judgment how necessary each relevant slice is to the task, and hand
 * back a ranking for the assembler. It is a separate asynchronous step so the assembler stays
 * pure and synchronous. The call sequence for the wiring is this step, then the assembler:
 *
 *   const { ranking } = await rankCapsuleSlices({ runtime, store, changeName, assembly });
 *   const capsule = assembleTaskCapsule({ ...assembly, ranking });
 *
 * Every case that yields no ranking (disabled, shadow, unavailable, abstained) leaves the
 * assembler to produce today's capsule.
 */

export const MAX_RANKED_SLICES = 30;
export const MAX_SLICE_EXCERPT_BYTES = MAX_EXCERPT_BYTES;

export interface RankCapsuleOptions {
  readonly runtime: JudgmentRuntime;
  readonly store: AtomicJsonStore;
  readonly changeName: string;
  /** What will be assembled; any ranking already on it is ignored. */
  readonly assembly: AssembleTaskCapsuleOptions;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export interface RankCapsuleResult {
  /** Present only in enforce mode when the gate acted; pass it to the assembler. */
  readonly ranking: CapsuleRanking | undefined;
  readonly recordId: string | null;
}

const NOTHING: RankCapsuleResult = { ranking: undefined, recordId: null };

/** The slices judgment is asked about: the first thirty relevant slices, in list order. */
export function slicesToRank(slices: readonly ContextSlice[] | undefined): ContextSlice[] {
  return (slices ?? []).filter((slice) => slice.priority === "relevant").slice(0, MAX_RANKED_SLICES);
}

function rankingFrom(value: CapsuleRankingGateValue, scored: readonly ContextSlice[]): CapsuleRanking {
  const ranking: Record<string, { score: number; confidence: number }> = {};
  for (const { index, score, confidence } of value.slices) {
    const slice = scored[index - 1];
    if (slice) ranking[slice.id] = { score, confidence };
  }
  return ranking;
}

export async function rankCapsuleSlices(options: RankCapsuleOptions): Promise<RankCapsuleResult> {
  // Disabled judgment does no work at all: nothing is built, sent, or recorded.
  if (!options.runtime.enabled) return NOTHING;
  const { contract, slices } = options.assembly;
  const scored = slicesToRank(slices);
  if (scored.length === 0) return NOTHING;

  const input = {
    task: {
      definition: contract.definition,
      requirements: contract.requirements,
      scenarios: contract.scenarios,
      decisions: contract.decisions,
      readScopes: contract.readScopes,
      writeScopes: contract.writeScopes,
      acceptance: contract.acceptance,
    },
    slices: scored.map(({ path, content }) => ({
      ...(path === undefined ? {} : { path }),
      excerpt: truncateBytes(content, MAX_SLICE_EXCERPT_BYTES),
    })),
  };
  let verdict;
  try {
    verdict = await options.runtime.judge(contextCapsuleRankingDecision, {
      input,
      changeName: options.changeName,
      phase: "implementation",
      taskId: contract.taskId,
      state: capsuleRankingState(input),
      sourcePaths: scored.flatMap(({ path }) => (path === undefined ? [] : [path])),
      signal: options.signal,
      deadlineMs: options.deadlineMs,
    });
  } catch (error) {
    // A missing recording is a test failure, not an outage; anything else must not fail assembly.
    if (error instanceof JudgmentFixtureMissingError) throw error;
    return NOTHING;
  }

  if (verdict.kind === "enforce") {
    return {
      ranking: verdict.outcome.act ? rankingFrom(verdict.outcome.value, scored) : undefined,
      recordId: verdict.recordId,
    };
  }
  if (verdict.kind === "shadow" && verdict.recordId) {
    await recordCounterfactual(options, scored, verdict.recordId);
  }
  return { ranking: undefined, recordId: verdict.recordId };
}

/**
 * In shadow mode the capsule is packed as today, and the record gets what ranking would have
 * done: which relevant slices it would include, demote, and list as oversized, and whether the
 * capsule would have differed. Both capsules come from the pure assembler. Measurement never
 * fails assembly, so a failure here leaves the record as it was.
 */
async function recordCounterfactual(
  options: RankCapsuleOptions,
  scored: readonly ContextSlice[],
  recordId: string,
): Promise<void> {
  try {
    const existing = await reconcileDecisionRecord(options.store, options.changeName, recordId, {});
    if (!existing.found) return;
    const gate = existing.record.gate;
    const ranking = gate?.act ? rankingFrom(gate.value as unknown as CapsuleRankingGateValue, scored) : undefined;
    const { ranking: _ignored, ...assembly } = options.assembly;
    const baseline = assembleTaskCapsule(assembly);
    const ranked = ranking ? assembleTaskCapsule({ ...assembly, ranking }) : baseline;
    const relevantIds = (slices: readonly { id: string; priority: string }[]) =>
      slices.filter((slice) => slice.priority === "relevant").map((slice) => slice.id);
    await reconcileDecisionRecord(options.store, options.changeName, recordId, {
      observed: {
        baselineIncluded: relevantIds(baseline.included),
        wouldInclude: relevantIds(ranked.included),
        wouldDemote: scored.filter((slice) => ranking && isDemotedByRanking(ranking[slice.id])).map((slice) => slice.id),
        wouldListOversized: (ranked.oversizedRequired ?? []).map((slice) => slice.id),
        differs: ranked.content !== baseline.content,
      },
    });
  } catch {
    // The counterfactual is measurement; the capsule the caller assembles is unaffected.
  }
}

/**
 * Reconciles a shadow record with the slices a builder later escalated for, so the number of
 * escalations ranking would have avoided can be counted: each escalated slice is marked with
 * whether ranking would have included it in the capsule. A record with no counterfactual is
 * reported as not found. Repeated calls merge, and a slice is recorded once.
 */
export async function reconcileCapsuleEscalations(
  store: AtomicJsonStore,
  changeName: string,
  recordId: string,
  escalatedSourceIds: readonly string[],
): Promise<{ readonly found: boolean }> {
  const existing = await reconcileDecisionRecord(store, changeName, recordId, {});
  if (!existing.found) return { found: false };
  const wouldInclude = existing.record.observed.wouldInclude;
  if (!Array.isArray(wouldInclude)) return { found: false };
  const previous = Array.isArray(existing.record.observed.escalations)
    ? (existing.record.observed.escalations as { sourceId: string; wouldHaveBeenIncluded: boolean }[])
    : [];
  const merged = [...previous];
  for (const sourceId of escalatedSourceIds) {
    if (merged.some((entry) => entry.sourceId === sourceId)) continue;
    merged.push({ sourceId, wouldHaveBeenIncluded: wouldInclude.includes(sourceId) });
  }
  await reconcileDecisionRecord(store, changeName, recordId, {
    observed: {
      escalations: merged,
      escalationsRankingWouldHaveAvoided: merged.filter((entry) => entry.wouldHaveBeenIncluded).length,
    },
  });
  return { found: true };
}
