import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SOURCE = resolve(ROOT, "src");

/** Modules a host or a child process loads by path, so nothing imports them. */
const ENTRY_POINTS: readonly string[] = [
  "src/muster/index.ts",
  "src/agents/child-broker.ts",
];

/**
 * Modules known to be unwired until the named change removes or connects them.
 * One line per entry, naming the change responsible. simplify-07-closeout asserts this is empty.
 */
const TEMPORARY_ALLOWLIST: Readonly<Record<string, string>> = {
  "src/context/ranking.ts": "simplify-03-judgment-core",
  "src/context/escalation.ts": "simplify-03-judgment-core",
  "src/context/assembler.ts": "simplify-03-judgment-core",
  "src/judgment/complexity-report.ts": "simplify-03-judgment-core",
  "src/judgment/model-routing-report.ts": "simplify-03-judgment-core",
  "src/judgment/preflight-report.ts": "simplify-03-judgment-core",
  "src/judgment/review-extraction-report.ts": "simplify-03-judgment-core",
  "src/judgment/review-triage-report.ts": "simplify-03-judgment-core",
  "src/judgment/task-quality-report.ts": "simplify-03-judgment-core",
  "src/judgment/task-review-report.ts": "simplify-03-judgment-core",
  "src/policies/debugging.ts": "simplify-06-lean-execution",
  "src/policies/repair-progress.ts": "simplify-06-lean-execution",
};

async function sourceModules(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceModules(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

function specifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+"([^"]+)"/g,
    /\bimport\s+"([^"]+)"/g,
    /\bimport\(\s*"([^"]+)"\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]!));
}

function repositoryPath(absolutePath: string): string {
  return relative(ROOT, absolutePath).replaceAll("\\", "/");
}

/** Every source module together with the source modules that import it. */
export async function importersBySourceModule(): Promise<Map<string, Set<string>>> {
  const modules = await sourceModules(SOURCE);
  const importers = new Map<string, Set<string>>(
    modules.map((path) => [repositoryPath(path), new Set<string>()]),
  );
  for (const path of modules) {
    for (const specifier of specifiers(await readFile(path, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      importers.get(repositoryPath(resolve(path, "..", specifier)))?.add(repositoryPath(path));
    }
  }
  return importers;
}

/** Modules that no chain of imports from a declared entry point reaches. */
function unwired(importers: Map<string, Set<string>>): string[] {
  const imports = new Map<string, string[]>();
  for (const [path, from] of importers) {
    for (const importer of from) imports.set(importer, [...(imports.get(importer) ?? []), path]);
  }
  const reached = new Set<string>(ENTRY_POINTS);
  const pending = [...ENTRY_POINTS];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    for (const next of imports.get(path) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  return [...importers.keys()].filter((path) => !reached.has(path)).sort();
}

describe("source hygiene", () => {
  test("every source module is reachable from an entry point or has an owner", async () => {
    const importers = await importersBySourceModule();
    const offenders = unwired(importers).filter((path) => !(path in TEMPORARY_ALLOWLIST));
    expect(offenders).toEqual([]);
  });

  test("a module no entry point reaches is reported as unwired", async () => {
    const importers = new Map<string, Set<string>>([
      ["src/muster/index.ts", new Set()],
      ["src/agents/child-broker.ts", new Set()],
      ["src/wired.ts", new Set(["src/muster/index.ts"])],
      ["src/only-tested.ts", new Set()],
      ["src/dead-chain.ts", new Set(["src/only-tested.ts"])],
    ]);
    expect(unwired(importers)).toEqual(["src/dead-chain.ts", "src/only-tested.ts"]);
  });

  test("declared entry points exist", async () => {
    const importers = await importersBySourceModule();
    for (const entry of ENTRY_POINTS) expect(importers.has(entry)).toBeTrue();
  });

  test("the temporary allowlist names its owner and lists only modules that still exist unwired", async () => {
    const importers = await importersBySourceModule();
    const currentlyUnwired = new Set(unwired(importers));
    for (const [path, owner] of Object.entries(TEMPORARY_ALLOWLIST)) {
      expect(owner).toMatch(/^simplify-\d\d-[a-z-]+$/);
      expect(importers.has(path)).toBeTrue();
      expect(currentlyUnwired.has(path)).toBeTrue();
    }
  });

  test("the retired unwired modules are gone", async () => {
    const importers = await importersBySourceModule();
    for (
      const path of [
        "src/agents/model-router.ts",
        "src/controller/state-precedence.ts",
        "src/change/manual-ui.ts",
        "src/telemetry/report.ts",
      ]
    ) {
      expect(importers.has(path)).toBeFalse();
    }
  });
});
