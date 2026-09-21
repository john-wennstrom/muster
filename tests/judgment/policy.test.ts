import { describe, expect, test } from "bun:test";
import { resolveJudgmentPolicy } from "../../src/judgment/policy.ts";

const flagValues = [undefined, "", "0", "1"] as const;
const keyValues = [undefined, "", "  ", "secret"] as const;
const modeValues = [undefined, "", "shadow", "enforce", "ENFORCE", "aggressive"] as const;

function expected(flag?: string, key?: string, mode?: string) {
  if (flag !== "1") return { enabled: false, reason: "disabled" };
  if (!key?.trim()) return { enabled: false, reason: "not_configured" };
  if (mode && mode !== "shadow" && mode !== "enforce") {
    return { enabled: false, reason: "invalid_configuration" };
  }
  return { enabled: true, mode: mode || "enforce", apiKey: key.trim() };
}

describe("judgment policy", () => {
  const rows = flagValues.flatMap((flag) =>
    keyValues.flatMap((key) => modeValues.map((mode) => [flag, key, mode] as const)));

  test.each(rows)("MUSTER_JEV=%p key=%p mode=%p", (flag, key, mode) => {
    const policy = resolveJudgmentPolicy({
      MUSTER_JEV: flag,
      MUSTER_JEV_API_KEY: key,
      MUSTER_JEV_MODE: mode,
    });
    expect(policy).toMatchObject(expected(flag, key, mode));
  });

  test("defaults to enforce once enabled", () => {
    expect(resolveJudgmentPolicy({ MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "k" }))
      .toEqual({ enabled: true, mode: "enforce", apiKey: "k" });
  });

  test("distinguishes disabled from not configured", () => {
    expect(resolveJudgmentPolicy({})).toMatchObject({ reason: "disabled" });
    expect(resolveJudgmentPolicy({ MUSTER_JEV_API_KEY: "k" })).toMatchObject({ reason: "disabled" });
    expect(resolveJudgmentPolicy({ MUSTER_JEV: "1" })).toMatchObject({ reason: "not_configured" });
  });

  test("an unrecognized mode is invalid configuration, not a mode", () => {
    expect(resolveJudgmentPolicy({
      MUSTER_JEV: "1",
      MUSTER_JEV_API_KEY: "k",
      MUSTER_JEV_MODE: "yolo",
    })).toMatchObject({ enabled: false, reason: "invalid_configuration" });
  });

  test("shadow is an explicit choice", () => {
    expect(resolveJudgmentPolicy({ MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "k", MUSTER_JEV_MODE: "shadow" }))
      .toEqual({ enabled: true, mode: "shadow", apiKey: "k" });
  });

  test("a per-decision variable has no effect", () => {
    const base = { MUSTER_JEV: "1", MUSTER_JEV_API_KEY: "k" };
    expect(resolveJudgmentPolicy({ ...base, MUSTER_JEV_REVIEW_TRIAGE: "1", MUSTER_JEV_MODEL_ROUTING: "1" }))
      .toEqual(resolveJudgmentPolicy(base));
  });

  test("does not read the process environment", () => {
    const previous = process.env.MUSTER_JEV;
    process.env.MUSTER_JEV = "1";
    try {
      expect(resolveJudgmentPolicy({})).toMatchObject({ enabled: false });
    } finally {
      if (previous === undefined) delete process.env.MUSTER_JEV;
      else process.env.MUSTER_JEV = previous;
    }
  });
});
