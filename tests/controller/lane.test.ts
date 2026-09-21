import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ComplexityInput } from "../../src/controller/complexity-router.ts";
import {
  chooseLane,
  escalateLane,
  LANE_POLICY,
  readLane,
  writeLane,
  type JudgedTriage,
} from "../../src/controller/lane.ts";
import { AtomicJsonStore } from "../../src/persistence/atomic-json-store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const quiet: ComplexityInput = {
  affectedFiles: ["src/parser.ts"],
  affectedCapabilities: ["parser"],
  hasPublicContractChange: false,
  hasDataMigration: false,
  hasSecurityBoundaryChange: false,
  hasDesignAmbiguity: false,
};

const allNo: JudgedTriage = {
  risks: {
    hasPublicContractChange: false,
    hasDataMigration: false,
    hasSecurityBoundaryChange: false,
    hasDesignAmbiguity: false,
  },
  reach: 0,
};

describe("chooseLane", () => {
  test("a user choice wins over every other input", () => {
    const choice = chooseLane({ pattern: { ...quiet, hasDataMigration: true }, judged: allNo, phase: "propose", userLane: "small" });
    expect(choice).toMatchObject({ lane: "small", source: "user" });
    expect(chooseLane({ pattern: quiet, judged: allNo, phase: "propose", userLane: "large" }).lane).toBe("large");
  });

  test("patterns alone never give small", () => {
    expect(chooseLane({ pattern: quiet, phase: "propose" })).toMatchObject({ lane: "medium", source: "pattern" });
    expect(chooseLane({ pattern: quiet, judged: null, phase: "propose" }).lane).toBe("medium");
  });

  test("direct and bounded patterns are medium, architectural is large", () => {
    expect(chooseLane({ pattern: { ...quiet, hasPublicContractChange: true }, phase: "propose" }).lane).toBe("medium");
    expect(chooseLane({ pattern: { ...quiet, hasDataMigration: true }, phase: "propose" }).lane).toBe("large");
    expect(chooseLane({ pattern: { ...quiet, affectedFiles: Array.from({ length: 12 }, (_, i) => `f${i}.ts`) }, phase: "propose" }).lane).toBe("large");
  });

  test("small when every condition holds", () => {
    const choice = chooseLane({ pattern: quiet, judged: allNo, phase: "propose" });
    expect(choice).toMatchObject({ lane: "small", source: "judgment" });
    expect(choice.reasons.join(" ")).toContain("every risk was judged no");
  });

  test("one uncertain risk keeps the lane out of small", () => {
    const { hasSecurityBoundaryChange: _uncertain, ...three } = allNo.risks;
    expect(chooseLane({ pattern: quiet, judged: { risks: three, reach: 0 }, phase: "propose" }).lane).toBe("medium");
  });

  test("an unconfident or wide reach keeps the lane out of small", () => {
    expect(chooseLane({ pattern: quiet, judged: { risks: allNo.risks }, phase: "propose" }).lane).toBe("medium");
    expect(chooseLane({ pattern: quiet, judged: { risks: allNo.risks, reach: 2 }, phase: "propose" }).lane).toBe("medium");
    expect(chooseLane({ pattern: quiet, judged: { risks: allNo.risks, reach: 1 }, phase: "propose" }).lane).toBe("small");
  });

  test("small needs a direct classification, so several files keep it medium", () => {
    const wide = { ...quiet, affectedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"] };
    expect(chooseLane({ pattern: wide, judged: allNo, phase: "propose" }).lane).toBe("medium");
  });

  test("a confident migration answer raises the lane", () => {
    const choice = chooseLane({ pattern: quiet, judged: { risks: { hasDataMigration: true } }, phase: "propose" });
    expect(choice).toMatchObject({ lane: "large", source: "judgment" });
    expect(choice.reasons.join(" ")).toContain("data migration as yes");
  });

  test("a confident no lowers a pattern false positive to medium, and never past it", () => {
    const choice = chooseLane({ pattern: { ...quiet, hasDataMigration: true }, judged: { risks: { hasDataMigration: false } }, phase: "propose" });
    expect(choice).toMatchObject({ lane: "medium", source: "judgment" });
  });

  test("an uncertain answer keeps the pattern value", () => {
    const choice = chooseLane({ pattern: { ...quiet, hasSecurityBoundaryChange: true }, judged: { risks: {} }, phase: "propose" });
    expect(choice).toMatchObject({ lane: "large", source: "pattern" });
  });

  test("design ambiguity applies only in refinement", () => {
    const judged: JudgedTriage = { risks: { hasDesignAmbiguity: true } };
    expect(chooseLane({ pattern: quiet, judged, phase: "propose" }).lane).toBe("medium");
    expect(chooseLane({ pattern: quiet, judged, phase: "refine" }).lane).toBe("large");
  });
});

describe("lane policy", () => {
  test("large adds opinions and a debate, small and medium add none", () => {
    expect(LANE_POLICY.large).toMatchObject({ specialistOpinions: 2, debate: true });
    for (const lane of ["small", "medium"] as const) {
      expect(LANE_POLICY[lane]).toMatchObject({ specialistOpinions: 0, debate: false });
    }
  });

  test("each lane declares its plan review mode, task limit and whether manual tasks are allowed", () => {
    expect(LANE_POLICY.small).toMatchObject({ planReview: "lint", maxTasks: 2, allowManualTasks: false });
    expect(LANE_POLICY.medium).toMatchObject({ planReview: "reviewer", maxTasks: 40, allowManualTasks: true });
    expect(LANE_POLICY.large).toMatchObject({ planReview: "reviewer", maxTasks: 40, allowManualTasks: true });
  });

  test("large never permits work reduction", () => {
    expect(LANE_POLICY.large.reducesWorkAllowed).toBe(false);
    expect(LANE_POLICY.small.reducesWorkAllowed).toBe(true);
    expect(LANE_POLICY.medium.reducesWorkAllowed).toBe(true);
  });
});

describe("lane record", () => {
  async function store() {
    const root = await mkdtemp(resolve(tmpdir(), "muster-lane-"));
    directories.push(root);
    return new AtomicJsonStore(root);
  }
  const at = (iso: string) => () => new Date(iso);

  test("a change with no lane record is medium", async () => {
    const record = await readLane(await store(), "add-search");
    expect(record).toMatchObject({ lane: "medium", source: "pattern", escalations: [] });
  });

  test("the chosen lane is recorded with its source, reasons and an empty history", async () => {
    const s = await store();
    await writeLane(s, "add-search", { lane: "small", source: "judgment", reasons: ["all risks judged no"], shadowLane: undefined }, at("2026-09-20T10:00:00.000Z"));
    expect(await readLane(s, "add-search")).toEqual({
      schemaVersion: 1,
      lane: "small",
      source: "judgment",
      reasons: ["all risks judged no"],
      escalations: [],
      decidedAt: "2026-09-20T10:00:00.000Z",
    });
  });

  test("a shadow lane is kept beside the lane in use", async () => {
    const s = await store();
    await writeLane(s, "add-search", { lane: "medium", source: "pattern", reasons: [], shadowLane: "small" });
    expect(await readLane(s, "add-search")).toMatchObject({ lane: "medium", shadowLane: "small" });
  });

  test("escalation moves the lane up and records the previous lane, the new lane, the reason and the time", async () => {
    const s = await store();
    await writeLane(s, "add-search", { lane: "small", source: "judgment", reasons: [] }, at("2026-09-20T10:00:00.000Z"));
    const escalated = await escalateLane(s, "add-search", "medium", "a write fell outside the declared scopes", at("2026-09-20T11:00:00.000Z"));
    expect(escalated.lane).toBe("medium");
    expect(escalated.escalations).toEqual([
      { from: "small", to: "medium", reason: "a write fell outside the declared scopes", at: "2026-09-20T11:00:00.000Z" },
    ]);
    expect((await readLane(s, "add-search")).escalations).toHaveLength(1);
  });

  test("a downgrade or a move to the same lane is refused and changes nothing", async () => {
    const s = await store();
    await writeLane(s, "add-search", { lane: "large", source: "user", reasons: [] });
    await expect(escalateLane(s, "add-search", "medium", "no reason")).rejects.toMatchObject({ code: "LANE_TRANSITION_INVALID" });
    await expect(escalateLane(s, "add-search", "large", "no reason")).rejects.toMatchObject({ code: "LANE_TRANSITION_INVALID" });
    const record = await readLane(s, "add-search");
    expect(record.lane).toBe("large");
    expect(record.escalations).toEqual([]);
  });

  test("an escalation needs a reason", async () => {
    const s = await store();
    await writeLane(s, "add-search", { lane: "small", source: "user", reasons: [] });
    await expect(escalateLane(s, "add-search", "medium", "  ")).rejects.toMatchObject({ code: "LANE_TRANSITION_INVALID" });
  });

  test("a change with no record can be escalated from its default medium", async () => {
    const s = await store();
    const record = await escalateLane(s, "add-search", "large", "design conflict");
    expect(record).toMatchObject({ lane: "large", escalations: [{ from: "medium", to: "large" }] });
  });
});
