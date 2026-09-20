/**
 * A pure, deterministic, line-based unified diff. It is what review triage sends for judgment:
 * the questions are about the change, and the diff carries the change without the two full texts.
 */

export const DIFF_CONTEXT_LINES = 5;

/** The total size, in bytes, of the diffs sent for one triage judgment. Larger is unavailable. */
export const DIFF_TOTAL_LIMIT_BYTES = 16_000;

/** Past this many cells the changed middle is shown as a whole replacement, not aligned line by line. */
const ALIGNMENT_CELL_LIMIT = 4_000_000;

type Operation = { readonly kind: " " | "-" | "+"; readonly line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline ends the last line; it does not start another.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The edit script from `before` to `after`, by the longest common subsequence of whole lines. */
function editScript(before: readonly string[], after: readonly string[]): Operation[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const left = before.slice(start, endBefore);
  const right = after.slice(start, endAfter);
  if ((left.length + 1) * (right.length + 1) > ALIGNMENT_CELL_LIMIT) {
    return [
      ...before.slice(0, start).map((line): Operation => ({ kind: " ", line })),
      ...left.map((line): Operation => ({ kind: "-", line })),
      ...right.map((line): Operation => ({ kind: "+", line })),
      ...before.slice(endBefore).map((line): Operation => ({ kind: " ", line })),
    ];
  }
  const width = right.length + 1;
  const lengths = new Uint32Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      lengths[row * width + column] = left[row] === right[column]
        ? lengths[(row + 1) * width + column + 1]! + 1
        : Math.max(lengths[(row + 1) * width + column]!, lengths[row * width + column + 1]!);
    }
  }

  const script: Operation[] = before.slice(0, start).map((line) => ({ kind: " ", line }));
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      script.push({ kind: " ", line: left[row]! });
      row += 1;
      column += 1;
    } else if (lengths[(row + 1) * width + column]! >= lengths[row * width + column + 1]!) {
      script.push({ kind: "-", line: left[row]! });
      row += 1;
    } else {
      script.push({ kind: "+", line: right[column]! });
      column += 1;
    }
  }
  for (; row < left.length; row += 1) script.push({ kind: "-", line: left[row]! });
  for (; column < right.length; column += 1) script.push({ kind: "+", line: right[column]! });
  script.push(...before.slice(endBefore).map((line): Operation => ({ kind: " ", line })));
  return script;
}

function range(start: number, count: number): string {
  // Unified diff convention: an empty range names the line before it.
  return count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;
}

/**
 * A unified diff of two texts with `DIFF_CONTEXT_LINES` lines of context. Identical texts give
 * an empty string. The same inputs always give the same output.
 */
export function unifiedDiff(before: string, after: string, contextLines: number = DIFF_CONTEXT_LINES): string {
  if (before === after) return "";
  const script = editScript(splitLines(before), splitLines(after));
  const changed = script.flatMap((operation, index) => operation.kind === " " ? [] : [index]);
  if (changed.length === 0) return "";

  // Each hunk spans a run of changes whose gaps are no wider than twice the context.
  const hunks: { from: number; to: number }[] = [];
  for (const index of changed) {
    const from = Math.max(0, index - contextLines);
    const to = Math.min(script.length, index + contextLines + 1);
    const last = hunks.at(-1);
    if (last && from <= last.to) last.to = to;
    else hunks.push({ from, to });
  }

  const output: string[] = [];
  for (const { from, to } of hunks) {
    let beforeStart = 1;
    let afterStart = 1;
    for (const operation of script.slice(0, from)) {
      if (operation.kind !== "+") beforeStart += 1;
      if (operation.kind !== "-") afterStart += 1;
    }
    const body = script.slice(from, to);
    const beforeCount = body.filter((operation) => operation.kind !== "+").length;
    const afterCount = body.filter((operation) => operation.kind !== "-").length;
    output.push(`@@ -${range(beforeStart, beforeCount)} +${range(afterStart, afterCount)} @@`);
    output.push(...body.map((operation) => `${operation.kind}${operation.line}`));
  }
  return `${output.join("\n")}\n`;
}

export interface DiffPair {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface FileDiff {
  readonly path: string;
  /** Empty when the file did not change. */
  readonly diff: string;
}

export type BoundedDiffs =
  | { readonly exceeded: false; readonly diffs: readonly FileDiff[]; readonly bytes: number }
  | { readonly exceeded: true; readonly bytes: number };

/**
 * The diff of each file, or a report that the total is over the cap. Never truncates: a diff cut
 * in the middle would show a judgment part of an edit and call it the edit.
 */
export function boundedDiffs(
  pairs: readonly DiffPair[],
  limitBytes: number = DIFF_TOTAL_LIMIT_BYTES,
): BoundedDiffs {
  const diffs = pairs.map(({ path, before, after }): FileDiff => ({ path, diff: unifiedDiff(before, after) }));
  const bytes = diffs.reduce((total, { diff }) => total + Buffer.byteLength(diff, "utf8"), 0);
  return bytes > limitBytes ? { exceeded: true, bytes } : { exceeded: false, diffs, bytes };
}
