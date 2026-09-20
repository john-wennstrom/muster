import { describe, expect, test } from "bun:test";
import { createDecisionRecord, type DecisionRecord } from "../../src/judgment/audit.ts";
import { summarizeReviewExtraction } from "../../src/judgment/review-extraction-report.ts";

interface Options {
  /** Whether the gate would have accepted the extraction. */
  accepted?: boolean;
  acted?: boolean;
  /** Omitted leaves the record unreconciled; otherwise the retry's verdict. */
  retry?: "APPROVE" | "REVISE";
  agreement?: boolean | null;
  status?: "answered" | "unavailable";
  version?: number;
  decision?: string;
}

function record(options: Options): DecisionRecord {
  const answered = (options.status ?? "answered") === "answered";
  const created = createDecisionRecord("add-search", {
    decision: options.decision ?? "review.extraction",
    decisionVersion: options.version ?? 1,
    phase: "planning",
    mode: options.acted ? "enforce" : "shadow",
    status: answered ? "answered" : "unavailable",
    unavailableReason: answered ? null : "network",
    requestedModel: "jev-1.13.0",
    reportedModel: answered ? "jev-1.13.0" : null,
    answers: answered ? {} : null,
    gate: !answered ? null : options.accepted
      ? { act: true, value: { verdict: "revise", verdictConfidence: 0.9, lines: [] } }
      : { act: false, reason: "abstained" },
    wouldHaveActed: Boolean(options.accepted),
    acted: options.acted ?? false,
    spend: null,
    stateDigest: "sha256:0",
  });
  return {
    ...created,
    observed: options.retry ? { retryVerdict: options.retry, retryBlocking: options.retry === "REVISE" ? 1 : 0 } : {},
    agreement: options.agreement ?? null,
  };
}

describe("review extraction report", () => {
  test("gives the acceptance rate over answered records and the agreement rate over compared ones", () => {
    const [report] = summarizeReviewExtraction([
      record({ accepted: true, retry: "REVISE", agreement: true }),
      record({ accepted: true, retry: "APPROVE", agreement: false }),
      record({ accepted: true, retry: "REVISE", agreement: true }),
      record({ accepted: false, retry: "REVISE" }),
    ]);

    expect(report).toEqual({
      decisionVersion: 1,
      unavailable: 0,
      answered: 4,
      wouldHaveAccepted: 3,
      acceptanceRate: 3 / 4,
      acted: 0,
      unreconciled: 0,
      compared: 3,
      agreed: 2,
      agreementRate: 2 / 3,
    });
  });

  test("an unreconciled accepted record counts as accepted but never as a disagreement", () => {
    const [report] = summarizeReviewExtraction([
      record({ accepted: true, retry: "REVISE", agreement: true }),
      record({ accepted: true }),
      record({ accepted: true }),
    ]);

    expect(report).toMatchObject({
      wouldHaveAccepted: 3,
      compared: 1,
      agreed: 1,
      agreementRate: 1,
      unreconciled: 2,
    });
  });

  test("a record accepted in enforce mode has no retry to compare and is unreconciled", () => {
    const [report] = summarizeReviewExtraction([
      record({ accepted: true, acted: true }),
      record({ accepted: true, retry: "REVISE", agreement: true }),
    ]);

    expect(report).toMatchObject({ acted: 1, unreconciled: 1, compared: 1, agreementRate: 1 });
  });

  test("unavailable records are counted apart and stay out of both rates", () => {
    const [report] = summarizeReviewExtraction([
      record({ status: "unavailable" }),
      record({ status: "unavailable" }),
      record({ accepted: true, retry: "REVISE", agreement: false }),
    ]);

    expect(report).toMatchObject({
      unavailable: 2,
      answered: 1,
      acceptanceRate: 1,
      compared: 1,
      agreed: 0,
      agreementRate: 0,
    });
  });

  test("both rates are null when there is nothing to divide", () => {
    const [onlyUnavailable] = summarizeReviewExtraction([record({ status: "unavailable" })]);
    const [noneAccepted] = summarizeReviewExtraction([record({ accepted: false, retry: "REVISE" })]);
    const [noneCompared] = summarizeReviewExtraction([record({ accepted: true })]);

    expect(onlyUnavailable).toMatchObject({ answered: 0, acceptanceRate: null, agreementRate: null });
    expect(noneAccepted).toMatchObject({ acceptanceRate: 0, agreementRate: null });
    expect(noneCompared).toMatchObject({ acceptanceRate: 1, agreementRate: null, unreconciled: 1 });
  });

  test("reports each decision version separately and ignores other decisions", () => {
    const reports = summarizeReviewExtraction([
      record({ version: 2, accepted: true, retry: "REVISE", agreement: true }),
      record({ version: 1, accepted: false }),
      record({ decision: "review.task_focus", accepted: true, retry: "APPROVE", agreement: false }),
    ]);

    expect(reports.map(({ decisionVersion }) => decisionVersion)).toEqual([1, 2]);
    expect(reports[0]).toMatchObject({ answered: 1, wouldHaveAccepted: 0 });
    expect(reports[1]).toMatchObject({ answered: 1, wouldHaveAccepted: 1, agreementRate: 1 });
  });

  test("no records give no report", () => {
    expect(summarizeReviewExtraction([])).toEqual([]);
  });
});
