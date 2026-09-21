import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { judgmentCatalog } from "../../src/judgment/catalog.ts";
import type { AnyDecision } from "../../src/judgment/decision.ts";

const DECISIONS = resolve(import.meta.dir, "../../src/judgment/decisions");
const modules = readdirSync(DECISIONS).filter((name) => name.endsWith(".ts")).sort();

const isDecision = (value: unknown): value is AnyDecision =>
  typeof value === "object" && value !== null
  && typeof (value as AnyDecision).id === "string"
  && typeof (value as AnyDecision).gate === "function"
  && typeof (value as AnyDecision).questions === "function";

describe("decision modules", () => {
  test("there is a module for each decision", () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  for (const name of modules) {
    test(`${name} defines exactly one decision, and the catalog lists it`, async () => {
      const exported = Object.values(await import(resolve(DECISIONS, name)));
      const decisions = exported.filter(isDecision);
      expect(decisions).toHaveLength(1);
      expect(judgmentCatalog).toContain(decisions[0]!);
    });
  }

  test("the catalog lists no decision that lacks a module", async () => {
    const defined = new Set<AnyDecision>();
    for (const name of modules) {
      for (const value of Object.values(await import(resolve(DECISIONS, name)))) if (isDecision(value)) defined.add(value);
    }
    expect(judgmentCatalog.filter((decision) => !defined.has(decision))).toEqual([]);
  });
});

describe("decision configuration", () => {
  test("no decision declares an enabling variable", () => {
    for (const decision of judgmentCatalog) {
      expect(Object.keys(decision), decision.id).not.toContain("enabledBy");
    }
  });
});
