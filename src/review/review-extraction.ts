import { tryJudge } from "../judgment/try.ts";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import { reviewExtractionDecision, reviewExtractionState, type ReviewExtractionGateValue } from "../judgment/decisions/review-extraction.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import {
  planningReviewSubmissionSchema,
  type PlanningReviewSubmission,
  type ReviewExtractionMark,
} from "./review-artifact.ts";

/**
 * Recovering a planning review from the reviewer's own prose. A reviewer that did not return
 * the required structured object has often still written its conclusions out in words. Code
 * finds the candidate lines, a typed judgment classifies them, and the review is assembled
 * from those lines verbatim, so nothing is generated. Everything here abstains into the
 * corrective retry: an unaccepted or unavailable extraction changes nothing.
 */

export const MAX_EXTRACTION_CANDIDATES = 60;
export const MAX_CANDIDATE_CHARACTERS = 400;
/** The most response text a judgment is given; a longer response is not extracted. */
export const MAX_EXTRACTION_RESPONSE_BYTES = 24_000;
const MAX_HEADING_CHARACTERS = 200;
/** A paragraph this short, ending in a colon, and followed by a list, introduces the list. */
const MAX_LABEL_CHARACTERS = 80;

export interface ReviewCandidate {
  /** One-based position among the candidates. */
  readonly index: number;
  /** The nearest heading above the candidate, or null when there is none. */
  readonly heading: string | null;
  /** A list item with its continuation lines, or a paragraph: markers removed, one line. */
  readonly text: string;
}

export type CandidateParse =
  | { readonly skipped: false; readonly candidates: readonly ReviewCandidate[] }
  | {
      readonly skipped: true;
      readonly reason: "response_too_large" | "too_many_candidates" | "candidate_too_long";
    };

const FENCE = /^\s{0,3}(?:```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const BOLD_LINE = /^\s{0,3}(\*\*|__)(.+?)\1\s*:?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,3}[.)])(?:\s+(.*))?$/;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
const indentOf = (line: string): number => line.match(/^\s*/)![0].replaceAll("\t", "    ").length;

/**
 * Splits a response into candidate lines: list items with their indented continuation lines
 * joined, and standalone paragraphs. Each carries the nearest heading above it. List markers
 * are removed and whitespace is normalized to a single line; no other markup is touched, so
 * every candidate is the reviewer's text. Code fences and rules contribute nothing. A response
 * over a limit is reported as skipped rather than truncated, because a judgment over part of a
 * review could reach a verdict the whole would not.
 */
export function parseReviewCandidates(response: string): CandidateParse {
  if (Buffer.byteLength(response, "utf8") > MAX_EXTRACTION_RESPONSE_BYTES) {
    return { skipped: true, reason: "response_too_large" };
  }
  const lines = response.split(/\r?\n/);
  const found: Array<{ heading: string | null; text: string }> = [];
  let heading: string | null = null;
  let current: { kind: "item" | "paragraph"; indent: number; parts: string[] } | null = null;
  let inFence = false;

  const flush = (): void => {
    if (!current) return;
    const text = normalize(current.parts.join(" "));
    if (text) found.push({ heading, text });
    current = null;
  };
  const setHeading = (text: string): void => {
    heading = normalize(text).slice(0, MAX_HEADING_CHARACTERS) || null;
  };
  const nextIsListItem = (from: number): boolean => {
    for (let next = from + 1; next < lines.length; next += 1) {
      if (lines[next]!.trim() === "") continue;
      return LIST_ITEM.test(lines[next]!) && !RULE.test(lines[next]!);
    }
    return false;
  };

  for (const [position, line] of lines.entries()) {
    if (FENCE.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "" || RULE.test(line)) {
      flush();
      continue;
    }
    const titled = HEADING.exec(line)?.[1] ?? BOLD_LINE.exec(line)?.[2];
    if (titled !== undefined) {
      flush();
      setHeading(titled.replace(/:\s*$/, ""));
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      current = { kind: "item", indent: indentOf(line), parts: [item[2] ?? ""] };
      continue;
    }
    const continues = current !== null
      && (current.kind === "paragraph" || indentOf(line) > current.indent);
    if (continues) {
      current!.parts.push(line);
      continue;
    }
    flush();
    const label = normalize(line);
    if (label.endsWith(":") && label.length <= MAX_LABEL_CHARACTERS && nextIsListItem(position)) {
      setHeading(label.slice(0, -1));
      continue;
    }
    current = { kind: "paragraph", indent: indentOf(line), parts: [line] };
  }
  flush();

  if (found.some(({ text }) => text.length > MAX_CANDIDATE_CHARACTERS)) {
    return { skipped: true, reason: "candidate_too_long" };
  }
  if (found.length > MAX_EXTRACTION_CANDIDATES) return { skipped: true, reason: "too_many_candidates" };
  return {
    skipped: false,
    candidates: found.map(({ heading: under, text }, position) => ({
      index: position + 1,
      heading: under,
      text,
    })),
  };
}

export type AssembledReview =
  | { readonly ok: true; readonly submission: PlanningReviewSubmission }
  | { readonly ok: false; readonly reason: string };

/**
 * Builds the review from the reviewer's own lines. Every candidate must have exactly one
 * classification, and the result must satisfy the same submission schema a parsed review does.
 * Lines classified as not a finding are left out; no text is written or reworded.
 */
export function assembleReviewSubmission(
  candidates: readonly ReviewCandidate[],
  value: ReviewExtractionGateValue,
): AssembledReview {
  const kinds = new Map<number, ReviewExtractionGateValue["lines"][number]["kind"]>();
  for (const line of value.lines) {
    if (kinds.has(line.index)) return { ok: false, reason: `line ${line.index} was classified twice` };
    kinds.set(line.index, line.kind);
  }
  const submission = { criticalFindings: [] as string[], requiredChanges: [] as string[], recommendations: [] as string[] };
  for (const candidate of candidates) {
    const kind = kinds.get(candidate.index);
    if (kind === undefined) return { ok: false, reason: `line ${candidate.index} was not classified` };
    if (kind === "critical") submission.criticalFindings.push(candidate.text);
    else if (kind === "required") submission.requiredChanges.push(candidate.text);
    else if (kind === "recommendation") submission.recommendations.push(candidate.text);
  }
  if (kinds.size !== candidates.length) return { ok: false, reason: "a classification names no candidate line" };
  const parsed = planningReviewSubmissionSchema.safeParse({
    verdict: value.verdict === "approve" ? "APPROVE" : "REVISE",
    ...submission,
  });
  return parsed.success
    ? { ok: true, submission: parsed.data }
    : { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

/** What the reviewer runner needs to try an extraction; absent means judgment plays no part. */
export interface PlanningReviewJudgment {
  readonly runtime: JudgmentRuntime;
  /** Where the decision record lives, so shadow mode can reconcile it with the retry. */
  readonly store: AtomicJsonStore;
}

export type ExtractionAttempt =
  | {
      readonly accepted: true;
      readonly submission: PlanningReviewSubmission;
      readonly mark: ReviewExtractionMark;
    }
  | {
      /** The decision record, when one was written, so a later result can be compared with it. */
      readonly accepted: false;
      readonly recordId: string | null;
    };

const declined = (recordId: string | null = null): ExtractionAttempt => ({ accepted: false, recordId });

/**
 * Tries to recover a review from a response that is not valid structured output. Declines,
 * doing no judgment work, when judgment is disabled, the response has no candidate lines, or a
 * limit is exceeded. Accepts only in enforce mode, only when the gate acted, only when the
 * lines assemble into a valid review, and only when the decision record can be named, because
 * an extracted review always carries its provenance. Never throws for an operational failure.
 */
export async function attemptReviewExtraction(
  judgment: PlanningReviewJudgment,
  changeName: string,
  response: string,
  signal?: AbortSignal,
): Promise<ExtractionAttempt> {
  const parsed = parseReviewCandidates(response);
  if (parsed.skipped || parsed.candidates.length === 0) return declined();

  const input = { response, candidates: parsed.candidates };
  const verdict = await tryJudge(judgment.runtime, reviewExtractionDecision, {
    input,
    changeName,
    phase: "planning",
    state: reviewExtractionState(input),
    signal,
  });
  if (!verdict) return declined();
  if (verdict.kind !== "enforce" || !verdict.outcome.act) return declined(verdict.recordId);
  const assembled = assembleReviewSubmission(parsed.candidates, verdict.outcome.value);
  if (!assembled.ok || verdict.recordId === null) return declined(verdict.recordId);
  return { accepted: true, submission: assembled.submission, mark: { recordId: verdict.recordId } };
}

/**
 * Compares a record's extraction with the review the retry produced. Agreement is on verdict,
 * and is set only where the gate would have accepted the extraction; the retry's findings are
 * freshly written and never match the extracted lines. Measurement only: it never throws.
 */
export async function reconcileReviewExtraction(
  judgment: PlanningReviewJudgment,
  changeName: string,
  recordId: string | null,
  retried: PlanningReviewSubmission,
): Promise<void> {
  const record = await judgment.runtime.reconcile(changeName, recordId, {
    observed: {
      retryVerdict: retried.verdict,
      retryBlocking: retried.criticalFindings.length + retried.requiredChanges.length,
    },
  });
  const gate = record?.gate;
  if (!gate?.act) return;
  const judged = (gate.value as { verdict?: unknown } | null)?.verdict;
  if (judged !== "approve" && judged !== "revise") return;
  await judgment.runtime.reconcile(changeName, recordId, {
    agreed: judged === (retried.verdict === "APPROVE" ? "approve" : "revise"),
  });
}
