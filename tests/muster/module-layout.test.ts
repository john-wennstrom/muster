import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const SURFACE = resolve(import.meta.dir, "../../src/change");

async function modules(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await modules(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

function specifiers(source: string): string[] {
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
}

function layerOf(path: string): "handlers" | "phases" | "surface" {
  const relativePath = relative(SURFACE, path).replaceAll("\\", "/");
  if (relativePath.startsWith("handlers/")) return "handlers";
  if (relativePath.startsWith("phases/")) return "phases";
  return "surface";
}

describe("change surface layering", () => {
  test("only the dependency assembly imports a handler module", async () => {
    const offenders: string[] = [];
    for (const path of await modules(SURFACE)) {
      const name = relative(SURFACE, path).replaceAll("\\", "/");
      if (layerOf(path) === "handlers" || name === "dependencies.ts") continue;
      for (const specifier of specifiers(await readFile(path, "utf8"))) {
        const target = resolve(path, "..", specifier);
        if (specifier.startsWith(".") && layerOf(target) === "handlers") {
          offenders.push(`${name} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the phase layer never imports the handler layer or the dependency assembly", async () => {
    const offenders: string[] = [];
    for (const path of await modules(SURFACE)) {
      if (layerOf(path) !== "phases") continue;
      for (const specifier of specifiers(await readFile(path, "utf8"))) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(path, "..", specifier);
        const name = relative(SURFACE, target).replaceAll("\\", "/");
        if (layerOf(target) === "handlers" || name === "dependencies.ts") {
          offenders.push(`${relative(SURFACE, path)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every handler module delegates rather than implementing a phase", async () => {
    const base = resolve(SURFACE, "handlers");
    const names = (await readdir(base)).filter((name) => name.endsWith(".ts"));
    expect(names).toHaveLength(9);
    for (const name of names) {
      const source = await readFile(resolve(base, name), "utf8");
      expect(source).toContain("defineChangeHandler");
      // A handler interprets arguments and calls one phase; real work lives in phases/.
      expect(source.split("\n").length).toBeLessThan(30);
      expect(source).not.toContain("OpenSpecAdapter");
      expect(source).not.toContain("GitAdapter");
      expect(source).not.toContain("runLegacyReadOnlyChild");
    }
  });

  test("no module outside the change surface imports a surface-internal module", async () => {
    const entryPoint = resolve(import.meta.dir, "../../src/muster/index.ts");
    const source = await readFile(entryPoint, "utf8");
    expect(specifiers(source).filter((specifier) => specifier.includes("../change/"))).toEqual([
      "../change/change-command.ts",
      "../change/dependencies.ts",
    ]);
  });
});

describe("dispatch decomposition", () => {
  const owners = {
    "parse.ts": ["parseChangeCommand"],
    "dispatch.ts": ["dispatchChangeCommand"],
    "outcome.ts": ["renderChangeStatus", "lifecycleBlocker", "emitOutcome"],
    "failure-outcome.ts": ["terminalErrorOutcome"],
    "register.ts": ["registerChangeCommand"],
  } as const;

  test("each dispatch responsibility is defined in exactly one module", async () => {
    const sources = new Map<string, string>();
    for (const name of await readdir(SURFACE)) {
      if (name.endsWith(".ts")) sources.set(name, await readFile(resolve(SURFACE, name), "utf8"));
    }
    for (const [owner, definitions] of Object.entries(owners)) {
      for (const definition of definitions) {
        const definedIn = [...sources].filter(([, source]) =>
          new RegExp(`(export )?(async )?function ${definition}\\b`).test(source)
        ).map(([name]) => name);
        expect({ definition, definedIn }).toEqual({ definition, definedIn: [owner] });
      }
    }
  });

  test("changing failure classification touches no other dispatch module", async () => {
    for (const name of Object.keys(owners)) {
      if (name === "failure-outcome.ts") continue;
      const source = await readFile(resolve(SURFACE, name), "utf8");
      expect({ name, mentions: source.includes("failureClassifications") }).toEqual({ name, mentions: false });
    }
  });

  test("the public entry-point module only re-exports", async () => {
    const source = await readFile(resolve(SURFACE, "change-command.ts"), "utf8");
    const code = source.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("/*"));
    expect(code.some((line) => /^(export )?(async )?function /.test(line.trim()))).toBe(false);
    expect(code.some((line) => line.trim().startsWith("const "))).toBe(false);
  });
});

