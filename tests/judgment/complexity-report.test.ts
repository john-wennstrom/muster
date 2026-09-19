import { describe, expect, test } from "bun:test";
import { createDecisionRecord, type DecisionRecord } from "../../src/judgment/audit.ts";
import { summarizeComplexityAgreement } from "../../src/judgment/complexity-report.ts";

type Signals = Partial<Record<
  "hasPublicContractChange" | "hasDataMigration" | "hasSecurityBoundaryChange" | "hasDesignAmbiguity",
  boolean
>>;

const pattern = (overrides: Signals = {}) => ({
  hasPublicContractChange: false,
  hasDataMigration: false,
  hasSecurityBoundaryChange: false,
  hasDesignAmbiguity: false,
  ...overrides,
});

/** A shadow-mode record; `reconciled: false` leaves agreement and observations empty. */
function record(
  change: string,
  judged: Signals | null,
  observed: Signals,
  options: { reconciled?: boolean; decision?: string; version?: number } = {},
): DecisionRecord {
  const created = createDecisionRecord(change, {
    decision: options.decision ?? "planning.complexity",
    decisionVersion: options.version ?? 1,
    phase: "planning",
    mode: "shadow",
    status: "answered",
    unavailableReason: null,
    requestedModel: "jev-1.13.0",
    reportedModel: "jev-1.13.0",
    answers: {},
    gate: judged ? { act: true, value: judged } : { act: false, reason: "no risk input was judged confidently" },
    wouldHaveActed: judged !== null,
    acted: false,
    spend: null,
    stateDigest: "sha256:0",
  });
  if (options.reconciled === false) return created;
  return { ...created, observed: pattern(observed), agreement: judged === null ? null : true };
}

function signal(report: ReturnType<typeof summarizeComplexityAgreement>[number], name: string) {
  return report.signals.find((entry) => entry.signal === name)!;
}

describe("summarizeComplexityAgreement", () => {
  test("reports nothing for no records and ignores other decisions", () => {
    expect(summarizeComplexityAgreement([])).toEqual([]);
    expect(summarizeComplexityAgreement([
      record("a", { hasDataMigration: true }, {}, { decision: "planning.other" }),
    ])).toEqual([]);
  });

  test("counts agreement per signal and the number of changes measured", () => {
    const [report] = summarizeComplexityAgreement([
      record("a", { hasDataMigration: false, hasPublicContractChange: true }, { hasPublicContractChange: true }),
      record("b", { hasDataMigration: false }, {}),
    ]);
    expect(report!.decisionVersion).toBe(1);
    expect(report!.changesMeasured).toBe(2);
    expect(signal(report!, "hasDataMigration")).toMatchObject({ measured: 2, agreed: 2, agreementRate: 1 });
    expect(signal(report!, "hasPublicContractChange")).toMatchObject({ measured: 1, agreed: 1, agreementRate: 1 });
  });

  test("distinguishes both directions of disagreement", () => {
    const [report] = summarizeComplexityAgreement([
      // Judgment says yes where the pattern said no (the wire-format prompt).
      record("a", { hasPublicContractChange: true }, { hasPublicContractChange: false }),
      // Judgment says no where the pattern said yes (the avoided-migration prompt).
      record("b", { hasDataMigration: false }, { hasDataMigration: true }),
      record("c", { hasDataMigration: false }, { hasDataMigration: true }),
    ]);
    expect(signal(report!, "hasPublicContractChange")).toMatchObject({
      measured: 1, agreed: 0, agreementRate: 0, judgedYesPatternNo: 1, judgedNoPatternYes: 0,
    });
    expect(signal(report!, "hasDataMigration")).toMatchObject({
      measured: 2, agreed: 0, agreementRate: 0, judgedYesPatternNo: 0, judgedNoPatternYes: 2,
    });
  });

  test("excludes abstentions from a signal's agreement without dropping the record", () => {
    const [report] = summarizeComplexityAgreement([
      record("a", { hasDataMigration: false }, { hasDataMigration: false, hasSecurityBoundaryChange: true }),
    ]);
    expect(signal(report!, "hasSecurityBoundaryChange")).toMatchObject({ measured: 0, agreementRate: null });
    expect(signal(report!, "hasDataMigration")).toMatchObject({ measured: 1, agreementRate: 1 });
    expect(report!.changesMeasured).toBe(1);
  });

  test("a call where the gate abstained on every signal measures nothing", () => {
    const [report] = summarizeComplexityAgreement([record("a", null, {})]);
    expect(report!.changesMeasured).toBe(0);
    expect(report!.signals.every((entry) => entry.measured === 0 && entry.agreementRate === null)).toBe(true);
  });

  test("excludes unreconciled records", () => {
    const [report] = summarizeComplexityAgreement([
      record("a", { hasDataMigration: true }, {}, { reconciled: false }),
      record("b", { hasDataMigration: false }, {}),
    ]);
    expect(signal(report!, "hasDataMigration")).toMatchObject({ measured: 1, agreed: 1 });
    expect(report!.changesMeasured).toBe(1);
  });

  test("counts a change once however many of its records were measured", () => {
    const [report] = summarizeComplexityAgreement([
      record("a", { hasDataMigration: false }, {}),
      record("a", { hasDataMigration: false }, {}),
    ]);
    expect(signal(report!, "hasDataMigration").measured).toBe(2);
    expect(report!.changesMeasured).toBe(1);
  });

  test("keeps decision versions apart", () => {
    const reports = summarizeComplexityAgreement([
      record("a", { hasDataMigration: false }, {}, { version: 2 }),
      record("a", { hasDataMigration: true }, {}, { version: 1 }),
    ]);
    expect(reports.map((report) => report.decisionVersion)).toEqual([1, 2]);
    expect(signal(reports[0]!, "hasDataMigration")).toMatchObject({ measured: 1, agreed: 0 });
    expect(signal(reports[1]!, "hasDataMigration")).toMatchObject({ measured: 1, agreed: 1 });
  });
});
