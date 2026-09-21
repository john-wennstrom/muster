import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createJudgmentRuntime } from "../../src/judgment/ask.ts";
import { judgmentCatalog, validateCatalog } from "../../src/judgment/catalog.ts";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { validateDecision } from "../../src/judgment/decision.ts";
import {
  changeTriageDecision,
  triageState,
  TRIAGE_CORROBORATION_FLOOR,
  TRIAGE_DISPOSITION_FLOOR,
} from "../../src/judgment/decisions/change-triage.ts";
import { TRIAGE_QUESTION_IDS as Q, triageCandidateQuestionId } from "../../src/judgment/questions.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";
import { createScriptedClient } from "../helpers/scripted-judgment.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const noul = (value: number) => ({ type: "noul" as const, noul: value });
const disposition = (choice: string, confidence: number) => ({
  type: "choice" as const,
  choice,
  probabilities: { [choice]: confidence },
  confidence,
});
const reach = (score: number, confidence = 0.9) => ({
  type: "score" as const,
  score,
  probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 },
  confidence,
});

/** Answers for a request with `candidates` retrieved files, each as [implements, needsChange]. */
function answers(
  choice: string,
  confidence: number,
  candidates: readonly (readonly [number, number])[] = [],
  overrides: JudgmentAnswers = {},
): JudgmentAnswers {
  return {
    [Q.disposition]: disposition(choice, confidence),
    ...Object.fromEntries(candidates.flatMap(([implemented, needsChange], position) => [
      [triageCandidateQuestionId(position + 1, "implements"), noul(implemented)],
      [triageCandidateQuestionId(position + 1, "needs_change"), noul(needsChange)],
    ])),
    [Q.publicContract]: noul(0.5),
    [Q.dataMigration]: noul(0.5),
    [Q.securityBoundary]: noul(0.5),
    [Q.designAmbiguity]: noul(0.5),
    [Q.mechanical]: noul(0.5),
    [Q.reach]: reach(1.5, 0.3),
    ...overrides,
  };
}

const gate = changeTriageDecision.gate;
const value = (input: JudgmentAnswers) => {
  const outcome = gate(input);
  if (!outcome.act) throw new Error(`expected an acting outcome, got: ${outcome.reason}`);
  return outcome.value;
};

describe("change.triage decision", () => {
  test("is registered, valid, and declares its effects", () => {
    expect(judgmentCatalog).toContain(changeTriageDecision);
    expect(() => validateCatalog(judgmentCatalog)).not.toThrow();
    expect(changeTriageDecision.effects).toEqual(["adds_caution", "reduces_work"]);
  });

  test("asks the disposition, two questions per candidate, the four risks, mechanical and reach", () => {
    expect(Object.keys(validateDecision(changeTriageDecision))).toEqual([
      "disposition",
      "candidate_1_implements", "candidate_1_needs_change",
      "candidate_2_implements", "candidate_2_needs_change",
      "public_contract", "data_migration", "security_boundary", "design_ambiguity", "mechanical", "reach",
    ]);
  });

  test("the state is the request, the phase and each candidate's path and excerpt, and nothing else", () => {
    expect(triageState({
      request: "Add search",
      phase: "refine",
      candidates: [{ path: "src/a.ts", excerpt: "1: x" }],
    })).toEqual({
      request: "Add search",
      phase: "refine",
      candidates: [{ index: 1, path: "src/a.ts", excerpt: "1: x" }],
    });
  });

  test("the wording keeps the scope and negation the merged questions had", () => {
    const wording = validateDecision(changeTriageDecision) as Record<string, { instructions: string }>;
    expect(wording[Q.dataMigration]!.instructions).toMatch(/explicitly avoids a migration[^.]*answers no/i);
    expect(wording[Q.publicContract]!.instructions).toMatch(/internal function signature[^.]*answers no/i);
    expect(wording[Q.securityBoundary]!.instructions).toMatch(/merely touches code near such logic[^.]*answers no/i);
    expect(wording.candidate_1_implements!.instructions).toMatch(/only mentions the same names[^.]*answers no/i);
  });

  describe("disposition", () => {
    test("a confident proceed acts", () => {
      expect(value(answers("proceed", 0.9, [[0.1, 0.9]]))).toMatchObject({
        disposition: "proceed",
        dispositionConfidence: 0.9,
        candidates: [{ index: 1, implements: 0.1, needsChange: 0.9, relevance: 0.9 }],
      });
    });

    test("a proceed below the floor does not act", () => {
      expect(value(answers("proceed", TRIAGE_DISPOSITION_FLOOR - 0.01, [], { [Q.publicContract]: noul(0.9) }))
        .disposition).toBeNull();
    });

    test("an already-satisfied disposition acts only when a candidate corroborates it", () => {
      expect(value(answers("already_satisfied", 0.95, [[TRIAGE_CORROBORATION_FLOOR + 0.05, 0.1]]))).toMatchObject({
        disposition: "already_satisfied",
      });
      expect(value(answers("already_satisfied", 0.95, [[0.3, 0.6]], { [Q.publicContract]: noul(0.9) })).disposition)
        .toBeNull();
      expect(value(answers("already_satisfied", 0.95, [[TRIAGE_CORROBORATION_FLOOR, 0.1]], { [Q.publicContract]: noul(0.9) }))
        .disposition).toBeNull();
    });

    test("needs clarification never acts, at any confidence", () => {
      const outcome = value(answers("needs_clarification", 0.99, [[0.1, 0.9]], { [Q.dataMigration]: noul(0.95) }));
      expect(outcome.disposition).toBeNull();
      expect(outcome.risks).toEqual({ hasDataMigration: true });
    });

    test("an unrecognized disposition does not act", () => {
      expect(value(answers("maybe", 0.99, [], { [Q.publicContract]: noul(0.9) })).disposition).toBeNull();
    });
  });

  describe("risks", () => {
    test("only confident answers are kept, strictly beyond the bands", () => {
      const outcome = value(answers("proceed", 0.9, [], {
        [Q.publicContract]: noul(0.71),
        [Q.dataMigration]: noul(0.29),
        [Q.securityBoundary]: noul(0.7),
        [Q.designAmbiguity]: noul(0.3),
      }));
      expect(outcome.risks).toEqual({ hasPublicContractChange: true, hasDataMigration: false });
    });

    test("a request that avoids a migration is carried as a confident no", () => {
      expect(value(answers("proceed", 0.9, [], { [Q.dataMigration]: noul(0.04) })).risks)
        .toEqual({ hasDataMigration: false });
    });

    test("uncertain answers leave every risk absent", () => {
      expect(value(answers("proceed", 0.9)).risks).toEqual({});
    });
  });

  describe("mechanical and reach", () => {
    test("mechanical follows the same bands", () => {
      expect(value(answers("proceed", 0.9, [], { [Q.mechanical]: noul(0.85) })).mechanical).toBe(true);
      expect(value(answers("proceed", 0.9, [], { [Q.mechanical]: noul(0.1) })).mechanical).toBe(false);
      expect(value(answers("proceed", 0.9, [], { [Q.mechanical]: noul(0.5) })).mechanical).toBeUndefined();
    });

    test("reach is a level only when it was judged with confidence", () => {
      expect(value(answers("proceed", 0.9, [], { [Q.reach]: reach(0.4, 0.9) })).reach).toBe(0);
      expect(value(answers("proceed", 0.9, [], { [Q.reach]: reach(1.4, 0.9) })).reach).toBe(1);
      expect(value(answers("proceed", 0.9, [], { [Q.reach]: reach(2.6, 0.9) })).reach).toBe(3);
      expect(value(answers("proceed", 0.9, [], { [Q.reach]: reach(0.4, 0.5) })).reach).toBeUndefined();
    });
  });

  test("nothing confident abstains", () => {
    expect(gate(answers("proceed", 0.5))).toEqual({ act: false, reason: "nothing was judged confidently" });
    expect(gate({})).toMatchObject({ act: false });
  });

  test("a runtime with a scripted client returns the acting outcome once, in enforce mode", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-triage-"));
    directories.push(root);
    const client = createScriptedClient({ "change.triage": answers("proceed", 0.9, [[0.1, 0.9], [0.2, 0.1]]) });
    const runtime = createJudgmentRuntime({
      env: { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "key" },
      store: new AtomicJsonStore(root),
      client,
    });
    const input = changeTriageDecision.representativeInput;
    const verdict = await runtime.judge(changeTriageDecision, {
      input,
      changeName: "add-search",
      phase: "planning",
      state: triageState(input),
    });
    expect(client.requests).toHaveLength(1);
    expect(verdict).toMatchObject({ kind: "enforce", outcome: { act: true, value: { disposition: "proceed" } } });
  });

  test("refinement state includes the previous review's required changes, because they are part of the request", () => {
    const state = triageState({
      request: "Refine search\n\nThe most recent planning review (round 1) requested REVISE. Address every required change below before returning to review:\n- Add a scenario",
      phase: "refine",
      candidates: [],
    }) as { request: string };
    expect(state.request).toContain("requested REVISE");
  });
});
