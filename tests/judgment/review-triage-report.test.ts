import { describe, expect, test } from "bun:test";
import { createDecisionRecord, type DecisionRecord } from "../../src/judgment/audit.ts";
import { summarizeReviewTriage } from "../../src/judgment/review-triage-report.ts";

interface Options {
  /** Whether the gate would have carried the approval forward. */
  carried?: boolean;
  acted?: boolean;
  /** Omitted leaves the record unreconciled; otherwise the verdict of the review that ran. */
  review?: "APPROVE" | "REVISE";
  status?: "answered" | "unavailable";
  version?: number;
  decision?: string;
}

/** A record as the controller leaves it: reconciled the way `reconcileReviewTriage` does it. */
function record(options: Options): DecisionRecord {
  const answered = (options.status ?? "answered") === "answered";
  const created = createDecisionRecord("add-search", {
    decision: options.decision ?? "review.triage",
    decisionVersion: options.version ?? 1,
    phase: "planning",
    mode: options.acted ? "enforce" : "shadow",
    status: answered ? "answered" : "unavailable",
    unavailableReason: answered ? null : "timeout",
    requestedModel: "jev-1.13.0",
    reportedModel: answered ? "jev-1.13.0" : null,
    answers: answered ? {} : null,
    gate: !answered ? null : options.carried
      ? { act: true, value: { materiality: 0, materialityConfidence: 0.95, changes: {} } }
      : { act: false, reason: "abstained" },
    wouldHaveActed: Boolean(options.carried),
    acted: options.acted ?? false,
    spend: null,
    stateDigest: "sha256:0",
  });
  return {
    ...created,
    observed: options.review ? { reviewVerdict: options.review } : {},
    agreement: options.review && options.carried ? options.review === "APPROVE" : null,
  };
}

describe("review triage report", () => {
  test("counts a false skip and an agreeing skip", () => {
    const [report] = summarizeReviewTriage([
      record({ carried: true, review: "APPROVE" }),
      record({ carried: true, review: "REVISE" }),
    ]);
    expect(report).toEqual({
      decisionVersion: 1,
      eligible: 2,
      unavailable: 0,
      answered: 2,
      abstained: 0,
      wouldHaveCarried: 2,
      carried: 0,
      unreconciled: 0,
      compared: 2,
      agreed: 1,
      falseSkips: 1,
      falseSkipRate: 0.5,
    });
  });

  test("an abstention is counted as eligible but is neither a skip nor a false skip", () => {
    const [report] = summarizeReviewTriage([
      record({ carried: false, review: "REVISE" }),
      record({ carried: true, review: "APPROVE" }),
    ]);
    expect(report).toMatchObject({ eligible: 2, abstained: 1, wouldHaveCarried: 1, compared: 1, falseSkips: 0, falseSkipRate: 0 });
  });

  test("unreconciled records are excluded from the comparison, not counted as agreeing", () => {
    const [report] = summarizeReviewTriage([
      record({ carried: true }),
      record({ carried: true, acted: true }),
      record({ carried: true, review: "REVISE" }),
    ]);
    expect(report).toMatchObject({
      wouldHaveCarried: 3,
      carried: 1,
      unreconciled: 2,
      compared: 1,
      agreed: 0,
      falseSkips: 1,
      falseSkipRate: 1,
    });
  });

  test("an unavailable record is eligible and nothing else", () => {
    const [report] = summarizeReviewTriage([record({ status: "unavailable" })]);
    expect(report).toMatchObject({ eligible: 1, unavailable: 1, answered: 0, wouldHaveCarried: 0, compared: 0, falseSkipRate: null });
  });

  test("other decisions are ignored, and versions are reported separately in order", () => {
    const reports = summarizeReviewTriage([
      record({ carried: true, review: "APPROVE", version: 2 }),
      record({ carried: true, review: "REVISE", version: 1 }),
      record({ decision: "review.extraction", carried: true, review: "REVISE" }),
    ]);
    expect(reports.map((report) => [report.decisionVersion, report.eligible, report.falseSkips])).toEqual([[1, 1, 1], [2, 1, 0]]);
    expect(summarizeReviewTriage([])).toEqual([]);
  });
});
