import { describe, expect, test } from "bun:test";
import {
  computeDiffDigest,
  computeIndexDigest,
  computeSourceDigest,
} from "../../src/execution/change-digests.ts";
import type { GitStatusEntry } from "../../src/execution/git.ts";

describe("change digests", () => {
  test("index digest is stable regardless of entry order", () => {
    const a: GitStatusEntry[] = [
      { kind: "ordinary", indexStatus: "M", worktreeStatus: ".", path: "b.ts" },
      { kind: "ordinary", indexStatus: "A", worktreeStatus: ".", path: "a.ts" },
    ];
    const b: GitStatusEntry[] = [a[1]!, a[0]!];

    expect(computeIndexDigest(a)).toBe(computeIndexDigest(b));
    expect(computeIndexDigest(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("index digest changes when status changes", () => {
    const clean: GitStatusEntry[] = [];
    const dirty: GitStatusEntry[] = [
      { kind: "untracked", indexStatus: "?", worktreeStatus: "?", path: "new.ts" },
    ];

    expect(computeIndexDigest(clean)).not.toBe(computeIndexDigest(dirty));
  });

  test("diff digest changes with diff content", () => {
    expect(computeDiffDigest("")).not.toBe(computeDiffDigest("diff --git a/x b/x\n"));
    expect(computeDiffDigest("same")).toBe(computeDiffDigest("same"));
  });

  test("source digest combines head commit and diff text", () => {
    const clean = computeSourceDigest("abc123", "");
    const dirtySameHead = computeSourceDigest("abc123", "diff --git a/x b/x\n");
    const newHeadClean = computeSourceDigest("def456", "");

    expect(clean).not.toBe(dirtySameHead);
    expect(clean).not.toBe(newHeadClean);
    expect(clean).toMatch(/^[a-f0-9]{64}$/);
  });
});
