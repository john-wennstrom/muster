import { describe, expect, test } from "bun:test";
import { createDecisionRecord, type DecisionRecord } from "../../src/judgment/audit.ts";
import { summarizeModelRouting } from "../../src/judgment/model-routing-report.ts";

interface Options {
  /** The lane the task ran on, as reconciled; omitted leaves the record unreconciled. */
  lane?: "primary" | "economy";
  /** The task's first-attempt pipeline status; omitted leaves the record unreconciled. */
  outcome?: string;
  /** Whether the gate would have chosen the economy lane. */
  routed?: boolean;
  mode?: "shadow" | "enforce";
  status?: "answered" | "unavailable";
  version?: number;
  decision?: string;
}

/** A record as the implementation phase leaves it once a task's first attempt has finished. */
function record(options: Options): DecisionRecord {
  const answered = (options.status ?? "answered") === "answered";
  const mode = options.mode ?? "shadow";
  const created = createDecisionRecord("add-search", {
    decision: options.decision ?? "routing.task_model",
    decisionVersion: options.version ?? 1,
    phase: "implementation",
    taskId: "1.1",
    mode,
    status: answered ? "answered" : "unavailable",
    unavailableReason: answered ? null : "timeout",
    requestedModel: "jev-1.13.0",
    reportedModel: answered ? "jev-1.13.0" : null,
    answers: answered ? {} : null,
    gate: !answered ? null : options.routed
      ? { act: true, value: { lane: "economy", mechanical: 0.9, risks: {}, reach: 0.4, reachConfidence: 0.9 } }
      : { act: false, reason: "abstained" },
    wouldHaveActed: Boolean(options.routed),
    acted: mode === "enforce" && Boolean(options.routed),
    spend: null,
    stateDigest: "sha256:0",
  });
  return {
    ...created,
    observed: options.lane && options.outcome ? { lane: options.lane, outcome: options.outcome } : {},
  };
}

describe("model routing report", () => {
  test("reports the task count and first-attempt share for each lane", () => {
    const [report] = summarizeModelRouting([
      record({ mode: "enforce", routed: true, lane: "economy", outcome: "completed" }),
      record({ mode: "enforce", routed: true, lane: "economy", outcome: "completed" }),
      record({ mode: "enforce", routed: true, lane: "economy", outcome: "blocked" }),
      record({ mode: "enforce", routed: false, lane: "primary", outcome: "completed" }),
      record({ mode: "enforce", routed: false, lane: "primary", outcome: "failed" }),
    ]);
    expect(report).toEqual({
      decisionVersion: 1,
      decided: 5,
      unreconciled: 0,
      lanes: {
        primary: { tasks: 2, completedFirstAttempt: 1, rate: 0.5 },
        economy: { tasks: 3, completedFirstAttempt: 2, rate: 2 / 3 },
      },
      wouldHaveRouted: { tasks: 0, completedFirstAttempt: 0, rate: null },
    });
  });

  test("a shadow-only population gives the baseline for the tasks that would have been routed", () => {
    const [report] = summarizeModelRouting([
      record({ routed: true, lane: "primary", outcome: "completed" }),
      record({ routed: true, lane: "primary", outcome: "design_conflict" }),
      record({ routed: true, lane: "primary", outcome: "completed" }),
      record({ routed: false, lane: "primary", outcome: "completed" }),
    ]);
    expect(report!.wouldHaveRouted).toEqual({ tasks: 3, completedFirstAttempt: 2, rate: 2 / 3 });
    expect(report!.lanes.primary).toEqual({ tasks: 4, completedFirstAttempt: 3, rate: 0.75 });
    expect(report!.lanes.economy).toEqual({ tasks: 0, completedFirstAttempt: 0, rate: null });
  });

  test("an empty lane has no rate rather than a zero", () => {
    const [report] = summarizeModelRouting([record({ lane: "primary", outcome: "completed" })]);
    expect(report!.lanes.economy.rate).toBeNull();
    expect(report!.wouldHaveRouted.rate).toBeNull();
  });

  test("an enforced economy task is a lane task, not a would-have-routed baseline task", () => {
    const [report] = summarizeModelRouting([
      record({ mode: "enforce", routed: true, lane: "economy", outcome: "completed" }),
    ]);
    expect(report!.lanes.economy.tasks).toBe(1);
    expect(report!.wouldHaveRouted.tasks).toBe(0);
  });

  test("unreconciled records are counted apart and excluded from every rate", () => {
    const [report] = summarizeModelRouting([
      record({ routed: true }),
      record({ routed: true, lane: "primary" }),
      record({ routed: true, outcome: "completed" }),
      record({ routed: true, lane: "primary", outcome: "completed" }),
    ]);
    expect(report!.decided).toBe(4);
    expect(report!.unreconciled).toBe(3);
    expect(report!.lanes.primary).toEqual({ tasks: 1, completedFirstAttempt: 1, rate: 1 });
    expect(report!.wouldHaveRouted).toEqual({ tasks: 1, completedFirstAttempt: 1, rate: 1 });
  });

  test("an unavailable judgment is a primary-lane task and never a would-have-routed one", () => {
    const [report] = summarizeModelRouting([
      record({ status: "unavailable", lane: "primary", outcome: "completed" }),
    ]);
    expect(report!.lanes.primary.tasks).toBe(1);
    expect(report!.wouldHaveRouted.tasks).toBe(0);
  });

  test("ignores other decisions and groups by decision version", () => {
    const reports = summarizeModelRouting([
      record({ decision: "review.triage", lane: "primary", outcome: "completed" }),
      record({ version: 2, lane: "primary", outcome: "completed" }),
      record({ version: 1, lane: "primary", outcome: "blocked" }),
    ]);
    expect(reports.map((report) => report.decisionVersion)).toEqual([1, 2]);
    expect(reports[0]!.decided).toBe(1);
    expect(reports[0]!.lanes.primary.completedFirstAttempt).toBe(0);
    expect(summarizeModelRouting([])).toEqual([]);
  });
});
