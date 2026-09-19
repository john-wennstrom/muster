import { describe, expect, test } from "bun:test";
import { createDecisionRecord, type DecisionRecord } from "../../src/judgment/audit.ts";
import { summarizePreflightAgreement } from "../../src/judgment/preflight-report.ts";

interface Options {
  judged: string;
  confidence?: number;
  /** The agent's disposition; omitted leaves the record unreconciled. */
  agent?: string;
  mode?: "shadow" | "enforce";
  producedBy?: "judgment" | "agent";
  wouldHaveActed?: boolean;
  version?: number;
  decision?: string;
}

function record(options: Options): DecisionRecord {
  const confidence = options.confidence ?? 0.9;
  const created = createDecisionRecord("add-search", {
    decision: options.decision ?? "planning.preflight",
    decisionVersion: options.version ?? 1,
    phase: "planning",
    mode: options.mode ?? "shadow",
    status: "answered",
    unavailableReason: null,
    requestedModel: "jev-1.13.0",
    reportedModel: "jev-1.13.0",
    answers: {
      disposition: { type: "choice", choice: options.judged, probabilities: { [options.judged]: confidence }, confidence },
    },
    gate: options.wouldHaveActed ? { act: true, value: {} } : { act: false, reason: "abstained" },
    wouldHaveActed: options.wouldHaveActed ?? false,
    acted: false,
    spend: null,
    stateDigest: "sha256:0",
  });
  const observed: Record<string, string> = {};
  if (options.producedBy) observed.producedBy = options.producedBy;
  if (options.agent) observed.agentDisposition = options.agent;
  return {
    ...created,
    observed,
    agreement: options.agent && (options.mode ?? "shadow") === "shadow" ? options.judged === options.agent : null,
  };
}

const unavailable = (): DecisionRecord => ({
  ...createDecisionRecord("add-search", {
    decision: "planning.preflight",
    decisionVersion: 1,
    phase: "planning",
    mode: "enforce",
    status: "unavailable",
    unavailableReason: "timeout",
    requestedModel: "jev-1.13.0",
    reportedModel: null,
    answers: null,
    gate: null,
    wouldHaveActed: false,
    acted: false,
    spend: null,
    stateDigest: null,
  }),
  observed: { producedBy: "agent", agentDisposition: "proceed" },
});

describe("summarizePreflightAgreement", () => {
  test("reports nothing for no records and ignores other decisions", () => {
    expect(summarizePreflightAgreement([])).toEqual([]);
    expect(summarizePreflightAgreement([record({ judged: "proceed", agent: "proceed", decision: "planning.complexity" })])).toEqual([]);
  });

  test("measures agreement between judged and agent dispositions", () => {
    const [report] = summarizePreflightAgreement([
      record({ judged: "proceed", agent: "proceed", producedBy: "agent" }),
      record({ judged: "proceed", agent: "proceed", producedBy: "agent" }),
      record({ judged: "needs_clarification", agent: "proceed", producedBy: "agent" }),
    ]);
    expect(report).toMatchObject({ reconciled: 3, agreed: 2 });
    expect(report!.agreementRate).toBeCloseTo(2 / 3);
  });

  test("precision counts a confident already-satisfied the agent did not return as false", () => {
    const [report] = summarizePreflightAgreement([
      record({ judged: "already_satisfied", agent: "already_satisfied" }),
      record({ judged: "already_satisfied", agent: "already_satisfied", confidence: 0.8 }),
      record({ judged: "already_satisfied", agent: "proceed" }),
      // Not confident, so it is neither right nor wrong about precision.
      record({ judged: "already_satisfied", agent: "proceed", confidence: 0.79 }),
      // A proceed is not an already-satisfied claim.
      record({ judged: "proceed", agent: "already_satisfied" }),
    ]);
    expect(report!.alreadySatisfied).toEqual({ confident: 3, agentAgreed: 2, precision: 2 / 3 });
    expect(report).toMatchObject({ reconciled: 5, agreed: 2 });
  });

  test("excludes unreconciled records and enforce-mode records the agent saw candidates for", () => {
    const [report] = summarizePreflightAgreement([
      record({ judged: "already_satisfied" }),
      record({ judged: "already_satisfied", agent: "proceed", mode: "enforce", producedBy: "agent" }),
      unavailable(),
    ]);
    expect(report).toMatchObject({
      calls: 3,
      answered: 2,
      reconciled: 0,
      agreed: 0,
      agreementRate: null,
      alreadySatisfied: { confident: 0, agentAgreed: 0, precision: null },
    });
  });

  test("counts how often the decision would have acted, over answered calls only", () => {
    const [report] = summarizePreflightAgreement([
      record({ judged: "proceed", agent: "proceed", wouldHaveActed: true }),
      record({ judged: "proceed", agent: "proceed", confidence: 0.6 }),
      record({ judged: "needs_clarification", agent: "needs_clarification" }),
      record({ judged: "already_satisfied", agent: "already_satisfied", wouldHaveActed: true }),
      unavailable(),
    ]);
    expect(report).toMatchObject({ answered: 4, wouldHaveActed: 2, actionRate: 0.5 });
  });

  test("an abstention is an answered call that would not have acted", () => {
    const [report] = summarizePreflightAgreement([record({ judged: "needs_clarification", confidence: 0.99, agent: "needs_clarification" })]);
    expect(report).toMatchObject({ answered: 1, wouldHaveActed: 0, actionRate: 0, reconciled: 1, agreed: 1 });
  });

  test("splits records by the path that produced the preflight", () => {
    const [report] = summarizePreflightAgreement([
      record({ judged: "proceed", mode: "enforce", producedBy: "judgment", wouldHaveActed: true }),
      record({ judged: "proceed", mode: "enforce", producedBy: "judgment", wouldHaveActed: true }),
      record({ judged: "proceed", agent: "proceed", producedBy: "agent" }),
      unavailable(),
      record({ judged: "proceed" }),
    ]);
    expect(report!.byPath).toEqual({ judgment: 2, agent: 2 });
  });

  test("reports each decision version separately", () => {
    const reports = summarizePreflightAgreement([
      record({ judged: "proceed", agent: "proceed", version: 2 }),
      record({ judged: "proceed", agent: "needs_clarification", version: 1 }),
    ]);
    expect(reports.map(({ decisionVersion, agreed }) => [decisionVersion, agreed])).toEqual([[1, 0], [2, 1]]);
  });
});
