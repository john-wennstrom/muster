import { describe, expect, test } from "bun:test";
import {
  assembleTaskCapsule,
  type AssembleTaskCapsuleOptions,
  type CapsuleRanking,
  type ContextSlice,
  type TaskCapsule,
} from "../../src/context/assembler.ts";
import { renderDependencyReports } from "../../src/agents/reports.ts";

const contract = {
  taskId: "9.1",
  definition: "Rank task context.",
  requirements: ["Ranking orders relevant slices"],
  scenarios: ["Higher-ranked slice is packed first"],
  decisions: [],
  readScopes: ["src/context/**"],
  writeScopes: ["src/context/**"],
  acceptance: ["Focused tests pass"],
  tokenBudget: 100,
};

const relevant = (id: string, tokenEstimate: number): ContextSlice => ({
  id,
  priority: "relevant",
  content: `content of ${id}`,
  tokenEstimate,
});

const assemble = (slices: readonly ContextSlice[], ranking?: CapsuleRanking, overrides: Partial<AssembleTaskCapsuleOptions> = {}) =>
  assembleTaskCapsule({ contract, requiredTokenEstimate: 40, slices, ranking, ...overrides });

const includedRelevant = (capsule: TaskCapsule) =>
  capsule.included.filter((slice) => slice.priority === "relevant").map((slice) => slice.id);

describe("ranked capsule packing", () => {
  test("a higher-ranked slice is packed before an earlier one and the other is available on demand", () => {
    const capsule = assemble(
      [relevant("first", 40), relevant("second", 40)],
      { first: { score: 1, confidence: 0.9 }, second: { score: 2.5, confidence: 0.9 } },
    );
    expect(includedRelevant(capsule)).toEqual(["second"]);
    expect(capsule.available).toEqual(["first"]);
    expect(capsule.content).toContain("content of second");
    expect(capsule.content).not.toContain("content of first");
  });

  test("orders by score times confidence, with ties in list order", () => {
    const capsule = assemble(
      [relevant("a", 10), relevant("b", 10), relevant("c", 10), relevant("d", 10)],
      {
        a: { score: 2, confidence: 0.5 }, // 1.0
        b: { score: 1, confidence: 1 }, // 1.0, ties with a and stays after it
        c: { score: 3, confidence: 0.6 }, // 1.8
        d: { score: 0.9, confidence: 0.4 }, // 0.36
      },
    );
    expect(includedRelevant(capsule)).toEqual(["c", "a", "b", "d"]);
  });

  test("the budget is never exceeded and required content is unchanged", () => {
    const slices = [relevant("a", 30), relevant("b", 30), relevant("c", 30)];
    const unranked = assemble(slices);
    const ranked = assemble(slices, { a: { score: 1, confidence: 1 }, b: { score: 3, confidence: 1 }, c: { score: 2, confidence: 1 } });
    expect(ranked.tokenEstimate).toBeLessThanOrEqual(ranked.tokenBudget);
    expect(ranked.included.slice(0, 1)).toEqual(unranked.included.slice(0, 1));
    const contractText = (capsule: TaskCapsule) => capsule.content.split("\n\ncontent of ")[0];
    expect(contractText(ranked)).toBe(contractText(unranked));
  });

  test("a slice judged unrelated with confidence is demoted despite spare budget", () => {
    const capsule = assemble([relevant("noise", 10)], { noise: { score: 0.2, confidence: 0.9 } });
    expect(includedRelevant(capsule)).toEqual([]);
    expect(capsule.available).toEqual(["noise"]);
    expect(capsule.content).not.toContain("content of noise");
  });

  test("a low-confidence unrelated slice is not demoted", () => {
    const capsule = assemble([relevant("noise", 10)], { noise: { score: 0.2, confidence: 0.4 } });
    expect(includedRelevant(capsule)).toEqual(["noise"]);
  });

  test("the demotion bands are inclusive of confidence and exclusive of score", () => {
    const capsule = assemble(
      [relevant("at-score", 10), relevant("at-confidence", 10)],
      { "at-score": { score: 0.5, confidence: 1 }, "at-confidence": { score: 0.49, confidence: 0.7 } },
    );
    expect(includedRelevant(capsule)).toEqual(["at-score"]);
    expect(capsule.available).toEqual(["at-confidence"]);
  });

  test("unscored slices follow scored slices in list order", () => {
    const capsule = assemble(
      [relevant("u1", 10), relevant("s1", 10), relevant("u2", 10), relevant("s2", 10)],
      { s1: { score: 1, confidence: 0.5 }, s2: { score: 1, confidence: 0.4 } },
    );
    expect(includedRelevant(capsule)).toEqual(["s1", "s2", "u1", "u2"]);
  });

  test("a required slice that does not fit is listed with its numbers and assembly succeeds", () => {
    const capsule = assemble(
      [relevant("small", 10), relevant("huge", 90)],
      { small: { score: 1, confidence: 0.9 }, huge: { score: 2.8, confidence: 0.9 } },
    );
    expect(capsule.oversizedRequired).toEqual([{ id: "huge", score: 2.8, confidence: 0.9, tokenEstimate: 90 }]);
    expect(capsule.available).toEqual(["huge"]);
  });

  test("a required slice judged with low confidence is not listed as oversized", () => {
    const capsule = assemble([relevant("huge", 90)], { huge: { score: 2.8, confidence: 0.5 } });
    expect(capsule.oversizedRequired).toEqual([]);
  });

  test("the stored ranking holds only the slices that were scored", () => {
    const capsule = assemble([relevant("a", 10), relevant("b", 10)], { a: { score: 2, confidence: 0.8 }, ghost: { score: 3, confidence: 1 } });
    expect(capsule.ranking).toEqual({ a: { score: 2, confidence: 0.8 } });
  });

  test("a non-finite ranking entry is treated as unscored", () => {
    const capsule = assemble([relevant("a", 10)], { a: { score: Number.NaN, confidence: 1 } });
    expect(includedRelevant(capsule)).toEqual(["a"]);
    expect(capsule.ranking).toEqual({});
  });

  test("required content that alone exceeds the budget still fails with a ranking", () => {
    expect(() => assemble([relevant("a", 10)], { a: { score: 3, confidence: 1 } }, { requiredTokenEstimate: 101 }))
      .toThrow(/Required context.*exceeds/);
    expect(() => assemble(
      [{ id: "rule", priority: "required", content: "rule", tokenEstimate: 70 }],
      {},
    )).toThrow(/Required context.*exceeds/);
  });
});

/** The assembler as it was before ranking, kept here as the reference for the property test. */
function previousAssemble(options: AssembleTaskCapsuleOptions): TaskCapsule {
  const budget = options.contract.tokenBudget;
  const slices = options.slices ?? [];
  const required = slices.filter((slice) => slice.priority === "required");
  const requiredTokens = options.requiredTokenEstimate + required.reduce((sum, slice) => sum + slice.tokenEstimate, 0);
  let tokenEstimate = requiredTokens;
  const included: Array<{ id: string; priority: "required" | "relevant" }> = [
    { id: "task-contract", priority: "required" },
    ...required.map((slice) => ({ id: slice.id, priority: "required" as const })),
  ];
  const contents = [`# Task ${options.contract.taskId}`, ...required.map((slice) => slice.content)];
  for (const slice of slices.filter((candidate) => candidate.priority === "relevant")) {
    if (tokenEstimate + slice.tokenEstimate > budget) continue;
    tokenEstimate += slice.tokenEstimate;
    included.push({ id: slice.id, priority: "relevant" });
    contents.push(slice.content);
  }
  const available = slices.filter((slice) => slice.priority === "available").map((slice) => slice.id);
  const excluded = slices.filter((slice) => slice.priority === "excluded").map((slice) => slice.id);
  return {
    taskId: options.contract.taskId,
    content: "",
    tokenBudget: budget,
    tokenEstimate,
    included,
    available,
    excluded,
  };
}

/** A small deterministic generator, so a failure reproduces from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomInputs(seed: number) {
  const next = random(seed);
  const priorities = ["required", "relevant", "relevant", "relevant", "available", "excluded"] as const;
  const count = Math.floor(next() * 12);
  const slices: ContextSlice[] = Array.from({ length: count }, (_, index) => ({
    id: `slice-${index}`,
    priority: priorities[Math.floor(next() * priorities.length)]!,
    content: `content ${index}`,
    tokenEstimate: Math.floor(next() * 40),
  }));
  const ranking: Record<string, { score: number; confidence: number }> = {};
  for (const slice of slices) {
    if (next() < 0.7) ranking[slice.id] = { score: next() * 3, confidence: next() };
  }
  return { slices, ranking, requiredTokenEstimate: Math.floor(next() * 30) };
}

describe("ranking properties", () => {
  const seeds = Array.from({ length: 300 }, (_, seed) => seed + 1);

  test("without a ranking the capsule is what it was before, field for field", () => {
    for (const seed of seeds) {
      const { slices, requiredTokenEstimate } = randomInputs(seed);
      const options = { contract: { ...contract, tokenBudget: 150 }, requiredTokenEstimate, slices };
      const requiredTokens = requiredTokenEstimate
        + slices.filter((slice) => slice.priority === "required").reduce((sum, slice) => sum + slice.tokenEstimate, 0);
      if (requiredTokens > 150) {
        expect(() => assembleTaskCapsule(options)).toThrow(/Required context.*exceeds/);
        continue;
      }
      const expected = previousAssemble(options);
      const actual = assembleTaskCapsule(options);
      expect({ ...actual, content: "" }).toEqual(expected);
      expect("ranking" in actual).toBe(false);
      expect("oversizedRequired" in actual).toBe(false);
    }
  });

  test("with any ranking the budget holds, required content is the same, and no slice is lost", () => {
    for (const seed of seeds) {
      const { slices, ranking, requiredTokenEstimate } = randomInputs(seed);
      const options = { contract: { ...contract, tokenBudget: 150 }, requiredTokenEstimate, slices };
      let unranked: TaskCapsule;
      try { unranked = assembleTaskCapsule(options); } catch { continue; }
      const ranked = assembleTaskCapsule({ ...options, ranking });
      expect(ranked.tokenEstimate).toBeLessThanOrEqual(ranked.tokenBudget);
      expect(ranked.included.filter((slice) => slice.priority === "required"))
        .toEqual(unranked.included.filter((slice) => slice.priority === "required"));
      expect(ranked.excluded).toEqual(unranked.excluded);
      const accounted = [...ranked.included.map((s) => s.id), ...ranked.available, ...ranked.excluded];
      expect(accounted.filter((id) => id !== "task-contract").sort())
        .toEqual(slices.map((slice) => slice.id).sort());
    }
  });
});

test("dependency reports are still rendered when a ranking is supplied", () => {
  const capsule = assemble([], {}, { dependencyReports: [] });
  expect(capsule.content).toContain(renderDependencyReports([]));
});
