import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createQuestionLoader } from "../../src/prompts/questions.ts";

const load = createQuestionLoader(resolve(import.meta.dir, "fixtures/judgment"));
const ids = (entries: readonly (readonly [string, unknown])[]) => entries.map(([id]) => id);

describe("judgment question loader", () => {
  test("expands a per-item group once per item, in item order", () => {
    const entries = load("sample.decision", {
      subject: "planning",
      candidates: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
    });
    expect(ids(entries)).toEqual([
      "disposition",
      "candidate_1_implements", "candidate_1_size",
      "candidate_2_implements", "candidate_2_size",
      "candidate_3_implements", "candidate_3_size",
      "coverage",
    ]);
    const second = Object.fromEntries(entries)["candidate_2_implements"] as { instructions: string };
    expect(second.instructions).toBe("Does candidate 2, b.ts, already do it?");
  });

  test("keeps the question types and criteria", () => {
    const entries = Object.fromEntries(load("sample.decision", { subject: "planning", candidates: [] })) as Record<string, any>;
    expect(entries.disposition).toEqual({ type: "choice", instructions: "What should planning do?", criteria: { go: "Go ahead.", stop: null } });
    expect(entries.coverage).toEqual({
      type: "noul",
      instructions: "Do the candidates cover the request?",
      criteria: { true: "Every part is covered.", false: "Some part is not." },
    });
  });

  test("a single question can repeat on its own", () => {
    const entries = load("single-repeat.decision", { lines: [{ text: "x" }, { text: "y" }] });
    expect(ids(entries)).toEqual(["line_1", "line_2"]);
  });

  test("a duplicate identifier is a programming error naming the decision", () => {
    expect(() => load("duplicate.decision")).toThrow(/duplicate\.decision.*same.*duplicates/);
  });

  test("an unknown variable names the decision", () => {
    expect(() => load("unknown-variable.decision")).toThrow(/unknown-variable\.decision.*\{\{missing\}\}/);
  });

  test("a choice without options is rejected by the shared validation", () => {
    expect(() => load("no-options.decision")).toThrow(/no-options\.decision.*pick/);
  });

  test("a repeat list that was not supplied is an error", () => {
    expect(() => load("single-repeat.decision", {})).toThrow(/lines/);
  });

  test("a missing file names the path", () => {
    expect(() => load("absent.decision")).toThrow(/absent\.decision.*absent\.decision\.yaml/);
  });
});
