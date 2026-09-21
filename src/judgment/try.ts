import type { z } from "zod";
import type { DecisionRecord } from "./audit.ts";
import type { GateOutcome, Decision } from "./decision.ts";
import type { JudgeRequest, JudgmentRuntime } from "./ask.ts";

/**
 * A verdict a call site can use. `reconcile` records what the ordinary path then did, and never
 * throws: recording is measurement, and a failure to write it must not fail the work.
 */
export type TriedVerdict<Value> = (
  | { readonly kind: "shadow" }
  | { readonly kind: "enforce"; readonly outcome: GateOutcome<Value> }
) & {
  readonly recordId: string | null;
  /** Merges observations into this decision's record; resolves to the merged record, or null. */
  reconcile(
    observed?: Readonly<Record<string, z.infer<typeof z.json>>>,
    agreed?: boolean,
  ): Promise<DecisionRecord | null>;
};

/**
 * Asks a decision and returns a verdict to use, or `null` when there is nothing to use: judgment
 * is disabled, or the service was unavailable, or anything else went wrong. Every caller does the
 * same thing then: what it does without judgment. It never throws for an operational failure.
 */
export async function tryJudge<Input, Value>(
  runtime: JudgmentRuntime,
  decision: Decision<Input, Value>,
  request: JudgeRequest<Input>,
): Promise<TriedVerdict<Value> | null> {
  if (!runtime.enabled) return null;
  let verdict;
  try {
    verdict = await runtime.judge(decision, request);
  } catch {
    return null;
  }
  if (verdict.kind === "fallback") return null;
  const reconcile: TriedVerdict<Value>["reconcile"] = (observed, agreed) =>
    runtime.reconcile(request.changeName, verdict.recordId, {
      ...(observed === undefined ? {} : { observed }),
      ...(agreed === undefined ? {} : { agreed }),
    });
  return verdict.kind === "shadow"
    ? { kind: "shadow", recordId: verdict.recordId, reconcile }
    : { kind: "enforce", outcome: verdict.outcome, recordId: verdict.recordId, reconcile };
}
