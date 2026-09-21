import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

/** The most lines a source module may have. The module specs aim lower; this is the backstop for everything. */
export const SOURCE_LINE_BUDGET = 500;
/** The most lines a test file may have without a stated reason. */
export const TEST_LINE_BUDGET = 600;

async function typescriptFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") found.push(...await typescriptFiles(path));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

const lineCount = (source: string): number => (source.endsWith("\n") ? source.slice(0, -1) : source).split("\n").length;

/** Whether the file's first comment has a line starting `size-budget:` that gives a reason. */
export function hasSizeBudgetReason(source: string): boolean {
  const first = /^\s*(?:\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n?)+)/.exec(source)?.[0] ?? "";
  return first.split("\n").some((line) => /^\s*(?:\/\/|\/?\*+|\*)?\s*size-budget:\s*\S/.test(line));
}

const repositoryPath = (path: string): string => relative(ROOT, path).replaceAll("\\", "/");

/** Every file over its budget that is not excused, as `path (N lines)`. */
export async function overBudget(): Promise<{ source: string[]; tests: string[] }> {
  const source: string[] = [];
  const tests: string[] = [];
  for (const path of await typescriptFiles(resolve(ROOT, "src"))) {
    const lines = lineCount(await readFile(path, "utf8"));
    if (lines > SOURCE_LINE_BUDGET) source.push(`${repositoryPath(path)} (${lines} lines)`);
  }
  for (const path of await typescriptFiles(resolve(ROOT, "tests"))) {
    const contents = await readFile(path, "utf8");
    const lines = lineCount(contents);
    if (lines > TEST_LINE_BUDGET && !hasSizeBudgetReason(contents)) tests.push(`${repositoryPath(path)} (${lines} lines)`);
  }
  return { source: source.sort(), tests: tests.sort() };
}

describe("size budget", () => {
  test(`no source module has more than ${SOURCE_LINE_BUDGET} lines`, async () => {
    expect((await overBudget()).source).toEqual([]);
  });

  test(`no test file has more than ${TEST_LINE_BUDGET} lines without a size-budget reason`, async () => {
    expect((await overBudget()).tests).toEqual([]);
  });

  test("a size-budget line in the first comment excuses a file, and only there", () => {
    expect(hasSizeBudgetReason("// size-budget: one long lifecycle scenario\nimport x from \"y\";\n")).toBeTrue();
    expect(hasSizeBudgetReason("/**\n * The lifecycle.\n * size-budget: one long lifecycle scenario\n */\nimport x from \"y\";\n")).toBeTrue();
    expect(hasSizeBudgetReason("import x from \"y\";\n// size-budget: too late\n")).toBeFalse();
    expect(hasSizeBudgetReason("// size-budget:\nimport x from \"y\";\n")).toBeFalse();
    expect(hasSizeBudgetReason("// nothing to see\nimport x from \"y\";\n")).toBeFalse();
  });
});
