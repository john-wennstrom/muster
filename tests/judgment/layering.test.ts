import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../../src");
const LAYER = resolve(SRC, "judgment");

/** Directories the layer may import from: shared, telemetry, and persistence, plus itself. */
const ALLOWED = ["judgment", "shared", "telemetry", "persistence"];

/** Named so a violation reads as what it is: modules that must depend on the layer, not reverse. */
const FORBIDDEN = [
  "change", "controller", "agents", "tools", "execution",
  "integrations", "review", "context", "policies", "muster", "openspec",
];

function specifiers(source: string): string[] {
  const found = [
    ...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
  ];
  return found.map((match) => match[1]!);
}

describe("judgment layer layering", () => {
  test("the layer exists and has modules to scan", async () => {
    const names = (await readdir(LAYER)).filter((name) => name.endsWith(".ts"));
    expect(names).toEqual(expect.arrayContaining([
      "ask.ts", "audit.ts", "client.ts", "egress.ts", "gates.ts",
      "policy.ts", "questions.ts", "replay.ts", "usage.ts",
    ]));
  });

  test("no module depends on a phase, handler, controller, agent, tool, or execution module", async () => {
    const offenders: string[] = [];
    for (const name of (await readdir(LAYER)).filter((entry) => entry.endsWith(".ts"))) {
      const path = resolve(LAYER, name);
      for (const specifier of specifiers(await readFile(path, "utf8"))) {
        if (!specifier.startsWith(".")) continue;
        const target = relative(SRC, resolve(LAYER, specifier)).replaceAll("\\", "/");
        const area = target.split("/")[0]!;
        const escapes = target.startsWith("..");
        if (escapes || FORBIDDEN.includes(area) || !ALLOWED.includes(area)) {
          offenders.push(`${name} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scan recognizes the shapes of import it must catch", () => {
    expect(specifiers(`import { a } from "../controller/x.ts";`)).toEqual(["../controller/x.ts"]);
    expect(specifiers(`import type { A } from '../change/phases/planning.ts';`)).toEqual(["../change/phases/planning.ts"]);
    expect(specifiers(`import "../agents/side-effect.ts";`)).toEqual(["../agents/side-effect.ts"]);
    expect(specifiers(`const m = await import("../execution/run.ts");`)).toEqual(["../execution/run.ts"]);
    expect(specifiers(`export { a } from "../tools/a.ts";`)).toEqual(["../tools/a.ts"]);
  });

  test("the layer's restrictions name exactly the modules the specification forbids", () => {
    for (const area of ["change", "controller", "agents", "tools", "execution"]) {
      expect(FORBIDDEN).toContain(area);
      expect(ALLOWED).not.toContain(area);
    }
  });
});
