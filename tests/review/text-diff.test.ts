import { describe, expect, test } from "bun:test";
import { DIFF_TOTAL_LIMIT_BYTES, boundedDiffs, unifiedDiff } from "../../src/review/text-diff.ts";

const lines = (count: number, prefix = "line"): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n";

describe("unifiedDiff", () => {
  test("identical texts give an empty result", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
    expect(unifiedDiff("", "")).toBe("");
  });

  test("an addition", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\nc\n")).toBe("@@ -1,2 +1,3 @@\n a\n b\n+c\n");
  });

  test("a removal", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nc\n")).toBe("@@ -1,3 +1,2 @@\n a\n-b\n c\n");
  });

  test("a replacement", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nB\nc\n")).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  });

  test("a whole new file and a whole removed file", () => {
    expect(unifiedDiff("", "a\n")).toBe("@@ -0,0 +1 @@\n+a\n");
    expect(unifiedDiff("a\n", "")).toBe("@@ -1 +0,0 @@\n-a\n");
  });

  test("keeps five lines of context on each side", () => {
    const before = lines(20);
    const after = before.replace("line 10\n", "changed\n");
    const diff = unifiedDiff(before, after);
    expect(diff.split("\n")[0]).toBe("@@ -5,11 +5,11 @@");
    expect(diff).toContain(" line 5\n");
    expect(diff).not.toContain(" line 4\n");
    expect(diff).toContain(" line 15\n");
    expect(diff).not.toContain(" line 16\n");
  });

  test("distant changes are separate hunks and near ones share a hunk", () => {
    const before = lines(60);
    const far = before.replace("line 3\n", "x\n").replace("line 50\n", "y\n");
    expect(unifiedDiff(before, far).split("\n").filter((line) => line.startsWith("@@"))).toHaveLength(2);
    const near = before.replace("line 20\n", "x\n").replace("line 28\n", "y\n");
    expect(unifiedDiff(before, near).split("\n").filter((line) => line.startsWith("@@"))).toHaveLength(1);
  });

  test("output is deterministic", () => {
    const before = lines(40);
    const after = before.replace("line 7\n", "").replace("line 30\n", "new\nother\n");
    expect(unifiedDiff(before, after)).toBe(unifiedDiff(before, after));
  });

  test("a large input with a small edit is cheap and small", () => {
    const before = lines(20_000);
    const after = before.replace("line 10000\n", "edited\n");
    const diff = unifiedDiff(before, after);
    expect(diff.split("\n").length).toBeLessThan(20);
    expect(diff).toContain("-line 10000\n+edited\n");
  });

  test("a large input that shares nothing still completes, as a whole replacement", () => {
    const diff = unifiedDiff(lines(5_000, "a"), lines(5_000, "b"));
    expect(diff.split("\n").filter((line) => line.startsWith("-"))).toHaveLength(5_000);
    expect(diff.split("\n").filter((line) => line.startsWith("+"))).toHaveLength(5_000);
  });
});

describe("boundedDiffs", () => {
  test("gives each file's diff and the total size", () => {
    const result = boundedDiffs([
      { path: "proposal.md", before: "a\n", after: "b\n" },
      { path: "design.md", before: "same\n", after: "same\n" },
    ]);
    expect(result.exceeded).toBe(false);
    if (result.exceeded) return;
    expect(result.diffs.map((entry) => entry.path)).toEqual(["proposal.md", "design.md"]);
    expect(result.diffs[1]!.diff).toBe("");
    expect(result.bytes).toBe(Buffer.byteLength(result.diffs[0]!.diff));
  });

  test("two prose diffs over the total cap report it instead of truncating", () => {
    const half = DIFF_TOTAL_LIMIT_BYTES / 2 + 500;
    const big = (name: string) => ({ path: name, before: "", after: `${"x".repeat(half)}\n` });
    const result = boundedDiffs([big("proposal.md"), big("design.md")]);
    expect(result.exceeded).toBe(true);
    expect(result).not.toHaveProperty("diffs");
    expect(result.bytes).toBeGreaterThan(DIFF_TOTAL_LIMIT_BYTES);
  });

  test("a total exactly at the cap is accepted", () => {
    const body = "x".repeat(100);
    const one = unifiedDiff("", `${body}\n`);
    const limit = Buffer.byteLength(one);
    expect(boundedDiffs([{ path: "p", before: "", after: `${body}\n` }], limit).exceeded).toBe(false);
    expect(boundedDiffs([{ path: "p", before: "", after: `${body}\n` }], limit - 1).exceeded).toBe(true);
  });
});
