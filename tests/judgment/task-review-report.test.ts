import { describe, expect, test } from "bun:test";
import { createDecisionRecord, type DecisionRecord } from "../../src/judgment/audit.ts";
import { summarizeTaskReviewFocus } from "../../src/judgment/task-review-report.ts";

interface Options {
  acted?: boolean;
  /** Item ids the gate chose; omitted means the gate abstained. */
  items?: string[];
  /** Omitted leaves the record unreconciled. */
  outcome?: { required: number; recommendations: number; raised?: string[] };
  status?: "answered" | "unavailable";
  version?: number;
  decision?: string;
}

function record(options: Options): DecisionRecord {
  const answered = (options.status ?? "answered") === "answered";
  const created = createDecisionRecord("add-widget", {
    decision: options.decision ?? "review.task_focus",
    decisionVersion: options.version ?? 1,
    phase: "implementation",
    taskId: "1.1",
    mode: options.acted ? "enforce" : "shadow",
    status: answered ? "answered" : "unavailable",
    unavailableReason: answered ? null : "network",
    requestedModel: "jev-1.13.0",
    reportedModel: answered ? "jev-1.13.0" : null,
    answers: answered ? {} : null,
    gate: !answered ? null : options.items
      ? { act: true, value: { items: options.items.map((id) => ({ id, phrase: id, area: "tests" })) } }
      : { act: false, reason: "abstained" },
    wouldHaveActed: Boolean(options.items),
    acted: options.acted ?? false,
    spend: null,
    stateDigest: "sha256:0",
  });
  return options.outcome
    ? { ...created, observed: { requiredFindings: options.outcome.required, recommendations: options.outcome.recommendations, areasRaised: [], focusItemsRaised: options.outcome.raised ?? [] } }
    : created;
}

describe("task review focus report", () => {
  test("compares focused and unfocused reviews", () => {
    const [report] = summarizeTaskReviewFocus([
      record({ acted: true, items: ["a", "b"], outcome: { required: 2, recommendations: 1, raised: ["a"] } }),
      record({ acted: true, items: ["c"], outcome: { required: 0, recommendations: 3, raised: [] } }),
      record({ items: ["a"], outcome: { required: 4, recommendations: 2, raised: ["a"] } }),
      record({ outcome: { required: 2, recommendations: 0 } }),
      record({ status: "unavailable", outcome: { required: 0, recommendations: 1 } }),
    ]);
    expect(report!.focused).toEqual({
      reviews: 2,
      meanRequiredFindings: 1,
      meanRecommendations: 2,
      focusItems: 3,
      focusItemsNamingRaisedArea: 1,
      namedRaisedAreaShare: 1 / 3,
    });
    expect(report!.unfocused).toEqual({
      reviews: 3,
      meanRequiredFindings: 2,
      meanRecommendations: 1,
      focusItems: 1,
      focusItemsNamingRaisedArea: 1,
      namedRaisedAreaShare: 1,
    });
  });

  test("an empty group reports no means and no share", () => {
    const [report] = summarizeTaskReviewFocus([record({ outcome: { required: 1, recommendations: 0 } })]);
    expect(report!.focused).toEqual({
      reviews: 0,
      meanRequiredFindings: null,
      meanRecommendations: null,
      focusItems: 0,
      focusItemsNamingRaisedArea: 0,
      namedRaisedAreaShare: null,
    });
    expect(report!.unfocused.reviews).toBe(1);
    expect(report!.unfocused.namedRaisedAreaShare).toBeNull();
  });

  test("unreconciled records are excluded from both groups", () => {
    const [report] = summarizeTaskReviewFocus([
      record({ acted: true, items: ["a"] }),
      record({ items: ["a"] }),
      record({ acted: true, items: ["a"], outcome: { required: 1, recommendations: 0, raised: ["a"] } }),
    ]);
    expect(report!.focused.reviews).toBe(1);
    expect(report!.unfocused.reviews).toBe(0);
  });

  test("other decisions are ignored and versions are reported separately", () => {
    const reports = summarizeTaskReviewFocus([
      record({ decision: "planning.preflight", outcome: { required: 9, recommendations: 9 } }),
      record({ version: 2, outcome: { required: 1, recommendations: 1 } }),
      record({ version: 1, outcome: { required: 3, recommendations: 0 } }),
    ]);
    expect(reports.map((report) => report.decisionVersion)).toEqual([1, 2]);
    expect(reports[0]!.unfocused.meanRequiredFindings).toBe(3);
    expect(summarizeTaskReviewFocus([])).toEqual([]);
  });
});
