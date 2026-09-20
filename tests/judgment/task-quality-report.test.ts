import { describe, expect, test } from "bun:test";
import { createDecisionRecord, type DecisionRecord } from "../../src/judgment/audit.ts";
import { summarizeTaskQuality } from "../../src/judgment/task-quality-report.ts";

type Outcome = readonly [status: string, flagged: string[]];

/** A record of one assessed change; `outcomes` maps a task to its reconciled outcome, and omits unreconciled tasks. */
function record(outcomes: Record<string, Outcome>, options: { decision?: string; version?: number; status?: "answered" | "unavailable" } = {}): DecisionRecord {
  const answered = (options.status ?? "answered") === "answered";
  const created = createDecisionRecord("add-widget", {
    decision: options.decision ?? "planning.task_quality",
    decisionVersion: options.version ?? 1,
    phase: "planning",
    mode: "shadow",
    status: answered ? "answered" : "unavailable",
    unavailableReason: answered ? null : "network",
    requestedModel: "jev-1.13.0",
    reportedModel: answered ? "jev-1.13.0" : null,
    answers: answered ? {} : null,
    gate: answered ? { act: false, reason: "abstained" } : null,
    wouldHaveActed: false,
    acted: false,
    spend: null,
    stateDigest: "sha256:0",
  });
  const observed = Object.fromEntries(Object.entries(outcomes).map(([task, [status, flagged]]) =>
    [`outcome:${task}`, { status, flagged }]));
  return { ...created, observed: { definitionDigest: "sha256:1", taskIds: Object.keys(outcomes), ...observed } };
}

const kindOf = (report: ReturnType<typeof summarizeTaskQuality>[number], kind: string) =>
  report.kinds.find((entry) => entry.kind === kind)!;

describe("task quality correlation report", () => {
  test("a kind with a strong correlation shows flagged tasks failing far more often", () => {
    const [report] = summarizeTaskQuality([
      record({ "1.1": ["blocked", ["verification"]], "1.2": ["failed", ["verification"]], "1.3": ["completed", []], "1.4": ["completed", []] }),
      record({ "1.1": ["blocked", ["verification"]], "1.2": ["completed", []] }),
    ]);
    expect(kindOf(report!, "verification")).toEqual({
      kind: "verification",
      flagged: { tasks: 3, notCompleted: 3, nonCompletionRate: 1 },
      unflagged: { tasks: 3, notCompleted: 0, nonCompletionRate: 0 },
    });
  });

  test("a kind with no correlation shows equal rates", () => {
    const [report] = summarizeTaskQuality([
      record({
        "1.1": ["blocked", ["scope"]], "1.2": ["completed", ["scope"]],
        "1.3": ["blocked", []], "1.4": ["completed", []],
      }),
    ]);
    const scope = kindOf(report!, "scope");
    expect(scope.flagged.nonCompletionRate).toBe(0.5);
    expect(scope.unflagged.nonCompletionRate).toBe(0.5);
  });

  test("an empty group has a null rate and a kind never flagged still appears", () => {
    const [report] = summarizeTaskQuality([record({ "1.1": ["completed", []], "1.2": ["blocked", []] })]);
    expect(report!.kinds.map(({ kind }) => kind)).toEqual(["verification", "scope", "atomicity", "dependencies", "size", "coverage"]);
    expect(kindOf(report!, "size").flagged).toEqual({ tasks: 0, notCompleted: 0, nonCompletionRate: null });
    expect(kindOf(report!, "size").unflagged).toEqual({ tasks: 2, notCompleted: 1, nonCompletionRate: 0.5 });
  });

  test("an all-flagged kind has an empty unflagged group", () => {
    const [report] = summarizeTaskQuality([record({ "1.1": ["blocked", ["coverage"]], "1.2": ["completed", ["coverage"]] })]);
    expect(kindOf(report!, "coverage").unflagged).toEqual({ tasks: 0, notCompleted: 0, nonCompletionRate: null });
  });

  test("unreconciled tasks are excluded, and so are records with no reconciled task", () => {
    const unreconciled = record({});
    const reports = summarizeTaskQuality([
      unreconciled,
      { ...record({ "1.1": ["blocked", ["atomicity"]] }), observed: { definitionDigest: "sha256:1", taskIds: ["1.1", "1.2"], "outcome:1.1": { status: "blocked", flagged: ["atomicity"] } } },
    ]);
    expect(reports).toHaveLength(1);
    expect(kindOf(reports[0]!, "atomicity").flagged.tasks).toBe(1);
    expect(kindOf(reports[0]!, "atomicity").unflagged.tasks).toBe(0);
    expect(summarizeTaskQuality([unreconciled])).toEqual([]);
  });

  test("ignores other decisions, unavailable records, and malformed observations", () => {
    const malformed = { ...record({}), observed: { "outcome:1.1": "completed", "outcome:1.2": { status: 3, flagged: [] }, "outcome:1.3": { status: "completed", flagged: "scope" } } };
    expect(summarizeTaskQuality([
      record({ "1.1": ["blocked", ["scope"]] }, { decision: "review.task_focus" }),
      record({ "1.1": ["blocked", ["scope"]] }, { status: "unavailable" }),
      malformed,
    ])).toEqual([]);
  });

  test("groups by decision version and ignores flagged kinds it does not know", () => {
    const reports = summarizeTaskQuality([
      record({ "1.1": ["blocked", ["scope", "made_up"]] }, { version: 2 }),
      record({ "1.1": ["completed", []] }, { version: 1 }),
    ]);
    expect(reports.map((report) => report.decisionVersion)).toEqual([1, 2]);
    expect(kindOf(reports[1]!, "scope").flagged.tasks).toBe(1);
  });
});
