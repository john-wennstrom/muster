import { describe, expect, test } from "bun:test";
import { parsePreflight } from "../../src/change/phases/planning.ts";
import {
  composePreflight,
  MAX_PREFLIGHT_EVIDENCE,
  STANDARD_ALREADY_SATISFIED_QUESTION,
  type PreflightCandidate,
} from "../../src/controller/preflight-composition.ts";
import type { PreflightGateValue } from "../../src/judgment/gates.ts";

const candidates = (count: number): PreflightCandidate[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index + 1}.ts`,
    matchedTerms: [`term${index + 1}`, "shared"],
  }));

const answer = (index: number, implemented: number, needsChange: number) => ({
  index,
  implements: implemented,
  needsChange,
  relevance: Math.max(implemented, needsChange),
});

const proceed = (...entries: ReturnType<typeof answer>[]): PreflightGateValue => ({
  disposition: "proceed",
  confidence: 0.9,
  candidates: entries,
});

describe("composePreflight", () => {
  test("keeps candidates judged relevant at 0.5 or more and ranks them by probability", () => {
    const composed = composePreflight(
      proceed(answer(1, 0.1, 0.5), answer(2, 0.2, 0.3), answer(3, 0.1, 0.95), answer(4, 0.49, 0.1)),
      candidates(4),
    );
    expect(composed.disposition).toBe("proceed");
    expect(composed.evidence.map(({ path }) => path)).toEqual(["src/file-3.ts", "src/file-1.ts"]);
  });

  test("ties keep candidate order", () => {
    const composed = composePreflight(proceed(answer(2, 0.1, 0.8), answer(1, 0.1, 0.8)), candidates(2));
    expect(composed.evidence.map(({ path }) => path)).toEqual(["src/file-1.ts", "src/file-2.ts"]);
  });

  test("caps evidence at eight, keeping the eight most relevant in descending order", () => {
    const entries = Array.from({ length: 12 }, (_, position) => answer(position + 1, 0.1, 0.5 + position * 0.04));
    const composed = composePreflight(proceed(...entries), candidates(12));
    expect(MAX_PREFLIGHT_EVIDENCE).toBe(8);
    expect(composed.evidence).toHaveLength(8);
    expect(composed.evidence.map(({ path }) => path)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5].map((index) => `src/file-${index}.ts`),
    );
  });

  test("each reason names the matched terms and the probability", () => {
    const [entry] = composePreflight(proceed(answer(1, 0.1, 0.873)), candidates(1)).evidence;
    expect(entry).toEqual({
      path: "src/file-1.ts",
      reason: "Matched term1, shared; judged relevant to the request (probability 0.87).",
    });
  });

  test("ignores an answer that names no candidate", () => {
    const composed = composePreflight(proceed(answer(1, 0.1, 0.9), answer(7, 0.1, 0.9)), candidates(2));
    expect(composed.evidence.map(({ path }) => path)).toEqual(["src/file-1.ts"]);
  });

  test("a confident proceed with nothing relevant has an empty evidence list and a summary", () => {
    const composed = composePreflight(proceed(answer(1, 0.1, 0.2)), candidates(1));
    expect(composed.evidence).toEqual([]);
    expect(composed.summary).toBe("Judged ready to plan: 0 of 1 candidate file retrieved are relevant to the request.");
  });

  test("the summary is a fixed sentence per disposition naming the counts", () => {
    expect(composePreflight(proceed(answer(1, 0.1, 0.9), answer(2, 0.1, 0.9)), candidates(3)).summary)
      .toBe("Judged ready to plan: 2 of 3 candidate files retrieved are relevant to the request.");
    expect(composePreflight(
      { disposition: "already_satisfied", confidence: 0.9, candidates: [answer(1, 0.9, 0.1), answer(2, 0.2, 0.6)] },
      candidates(4),
    ).summary).toBe(
      "Judged already satisfied by the checked-out code: 1 of 4 candidate files retrieved already implement the request.",
    );
  });

  test("a composed result satisfies the schema the agent path is held to", () => {
    for (const value of [
      proceed(answer(1, 0.1, 0.9)),
      proceed(),
      { disposition: "already_satisfied" as const, confidence: 0.9, candidates: [answer(1, 0.9, 0.1)] },
    ]) {
      const composed = composePreflight(value, candidates(2));
      expect(composed.summary.length).toBeGreaterThan(0);
      for (const entry of composed.evidence) {
        expect(entry.path.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(0);
      }
      expect(parsePreflight(JSON.stringify(composed))).toEqual(composed);
    }
  });

  test("an already-satisfied composition has the fields the agent path yields for that disposition", () => {
    const composed = composePreflight(
      { disposition: "already_satisfied", confidence: 0.9, candidates: [answer(1, 0.9, 0.1)] },
      candidates(1),
    );
    // The agent path returns disposition, summary, and evidence, with no question: the phase
    // supplies the standard one, which is exported here so both paths share it.
    const agent = parsePreflight(JSON.stringify({
      disposition: "already_satisfied",
      summary: "The code already does this.",
      evidence: [{ path: "src/file-1.ts", reason: "Implements it." }],
    }));
    expect(Object.keys(composed).sort()).toEqual(Object.keys(agent).sort());
    expect(composed).not.toHaveProperty("question");
    expect(STANDARD_ALREADY_SATISFIED_QUESTION).toBe(
      "Which branch, deployment, or entry point still exhibits the behavior you want changed?",
    );
  });
});
