import type { DecisionRecord } from "./audit.ts";
import { COMPLEXITY_SIGNALS, planningComplexityDecision, type JudgedComplexityInputs } from "./gates.ts";

/**
 * Per-signal agreement between the judged risk inputs and the pattern values, from the records
 * of `planning.complexity`. Disagreement is not error: it is the review queue, and someone
 * reads it before enforce is considered. Pure, so the calibration script and any report share it.
 */

export interface SignalAgreement {
  readonly signal: keyof JudgedComplexityInputs;
  /** Records where this signal was judged confidently and the record was reconciled. */
  readonly measured: number;
  readonly agreed: number;
  /** Null when nothing was measured for this signal. */
  readonly agreementRate: number | null;
  /** Judgment said yes where the pattern said no. */
  readonly judgedYesPatternNo: number;
  /** Judgment said no where the pattern said yes. */
  readonly judgedNoPatternYes: number;
}

export interface ComplexityAgreementReport {
  readonly decisionVersion: number;
  /** Distinct changes with at least one measured record. */
  readonly changesMeasured: number;
  readonly signals: readonly SignalAgreement[];
}

export function summarizeComplexityAgreement(
  records: readonly DecisionRecord[],
): readonly ComplexityAgreementReport[] {
  const byVersion = new Map<number, DecisionRecord[]>();
  for (const record of records) {
    if (record.decision !== planningComplexityDecision.id) continue;
    byVersion.set(record.decisionVersion, [...(byVersion.get(record.decisionVersion) ?? []), record]);
  }
  return [...byVersion.entries()]
    .sort(([left], [right]) => left - right)
    .map(([decisionVersion, group]) => {
      // An unreconciled record has nothing to compare with, and an abstaining gate has no judged values.
      const reconciled = group.filter((record) =>
        record.agreement !== null && record.gate?.act === true);
      const signals = COMPLEXITY_SIGNALS.map(([signal]): SignalAgreement => {
        let measured = 0;
        let agreed = 0;
        let judgedYesPatternNo = 0;
        let judgedNoPatternYes = 0;
        for (const record of reconciled) {
          const judged = judgedValue(record, signal);
          const pattern = record.observed[signal];
          if (judged === undefined || typeof pattern !== "boolean") continue;
          measured += 1;
          if (judged === pattern) agreed += 1;
          else if (judged) judgedYesPatternNo += 1;
          else judgedNoPatternYes += 1;
        }
        return {
          signal,
          measured,
          agreed,
          agreementRate: measured === 0 ? null : agreed / measured,
          judgedYesPatternNo,
          judgedNoPatternYes,
        };
      });
      return {
        decisionVersion,
        changesMeasured: new Set(reconciled.map((record) => record.runId)).size,
        signals,
      };
    });
}

/** The confident judged value for a signal; undefined when the gate abstained on it. */
function judgedValue(record: DecisionRecord, signal: keyof JudgedComplexityInputs): boolean | undefined {
  if (record.gate?.act !== true) return undefined;
  const value = record.gate.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const judged = (value as Record<string, unknown>)[signal];
  return typeof judged === "boolean" ? judged : undefined;
}
