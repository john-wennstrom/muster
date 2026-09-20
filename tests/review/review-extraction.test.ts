import { describe, expect, test } from "bun:test";
import {
  MAX_CANDIDATE_CHARACTERS,
  MAX_EXTRACTION_CANDIDATES,
  MAX_EXTRACTION_RESPONSE_BYTES,
  parseReviewCandidates,
} from "../../src/review/review-extraction.ts";

function candidatesOf(response: string) {
  const parsed = parseReviewCandidates(response);
  if (parsed.skipped) throw new Error(`unexpectedly skipped: ${parsed.reason}`);
  return parsed.candidates;
}

const texts = (response: string) => candidatesOf(response).map(({ text }) => text);

describe("review candidate parser", () => {
  test("reads bulleted items with their markers removed", () => {
    expect(texts("- The migration has no rollback.\n* Tasks omit the failure scenario.\n+ Design lacks a limit."))
      .toEqual([
        "The migration has no rollback.",
        "Tasks omit the failure scenario.",
        "Design lacks a limit.",
      ]);
  });

  test("reads numbered items in both marker styles", () => {
    expect(texts("1. First problem.\n2) Second problem.\n10. Tenth problem."))
      .toEqual(["First problem.", "Second problem.", "Tenth problem."]);
  });

  test("joins indented continuation lines into one line", () => {
    const response = [
      "- The rollback step is missing and the design does",
      "  not say what happens to rows written before the",
      "\tfailure.",
      "- A second, short item.",
    ].join("\n");

    expect(texts(response)).toEqual([
      "The rollback step is missing and the design does not say what happens to rows written before the failure.",
      "A second, short item.",
    ]);
  });

  test("keeps a nested item as its own candidate", () => {
    expect(texts("- Parent point.\n  - Nested point.\n- Next point.")).toEqual([
      "Parent point.",
      "Nested point.",
      "Next point.",
    ]);
  });

  test("reads standalone paragraphs, joining wrapped lines", () => {
    const response = "The plan is sound overall.\n\nHowever the second\ntask depends on an unwritten helper.";

    expect(texts(response)).toEqual([
      "The plan is sound overall.",
      "However the second task depends on an unwritten helper.",
    ]);
  });

  test("carries the nearest preceding heading, and none before the first", () => {
    const response = [
      "Overall the plan is close.",
      "",
      "## Required changes",
      "",
      "- Add the rollback.",
      "",
      "### Recommendations",
      "- Shorten the task list.",
    ].join("\n");

    expect(candidatesOf(response).map(({ heading, text }) => [heading, text])).toEqual([
      [null, "Overall the plan is close."],
      ["Required changes", "Add the rollback."],
      ["Recommendations", "Shorten the task list."],
    ]);
  });

  test("treats a bold line or a short label before a list as a heading", () => {
    const response = "**Critical findings**\n- No rollback.\n\nRequired changes:\n- Add a limit.";

    expect(candidatesOf(response).map(({ heading, text }) => [heading, text])).toEqual([
      ["Critical findings", "No rollback."],
      ["Required changes", "Add a limit."],
    ]);
  });

  test("does not treat a long colon-terminated paragraph as a heading", () => {
    const long = `${"The reviewer walked through every artifact in the reviewed set and noted the following".padEnd(90, " x")}:`;

    expect(texts(`${long}\n- A point.`)).toEqual([long, "A point."]);
  });

  test("leaves code fences and rules out", () => {
    const response = "Finding one.\n\n```json\n{\"verdict\": \"REVISE\"\n```\n\n---\n\n- Finding two.";

    expect(texts(response)).toEqual(["Finding one.", "Finding two."]);
  });

  test("normalizes whitespace and touches no other markup", () => {
    expect(texts("-   The   `parse()`\t call is **unsafe**  and _unchecked_.  ")).toEqual([
      "The `parse()` call is **unsafe** and _unchecked_.",
    ]);
  });

  test("handles CRLF line endings", () => {
    expect(texts("- One.\r\n- Two.\r\n")).toEqual(["One.", "Two."]);
  });

  test("numbers candidates from one in order", () => {
    expect(candidatesOf("- A.\n- B.\n\nC.").map(({ index }) => index)).toEqual([1, 2, 3]);
  });

  test("an empty or blank response has no candidates and is not skipped", () => {
    for (const response of ["", "   \n\n\t\n", "-\n", "---\n\n```\ncode\n```"]) {
      expect(parseReviewCandidates(response)).toEqual({ skipped: false, candidates: [] });
    }
  });

  test("every candidate is a line of the input after marker removal and normalization", () => {
    const response = [
      "## Review",
      "",
      "The plan is well organized.",
      "",
      "- Missing rollback for the",
      "  migration step.",
      "- No limit on retries.",
      "",
      "1. Add the failure scenario.",
      "2. Split task 3.",
    ].join("\n");
    const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
    const marker = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
    const source = response.split("\n").map((line) => normalized(line.replace(marker, "")));
    // A wrapped item is the normalized join of consecutive input lines, so compare joins too.
    const joins = source.flatMap((line, position) => [line, normalized(`${line} ${source[position + 1] ?? ""}`)]);

    for (const { text } of candidatesOf(response)) expect(joins).toContain(text);
    expect(candidatesOf(response)).toHaveLength(5);
  });
});

describe("review candidate limits", () => {
  test("accepts exactly the maximum number of candidates", () => {
    const response = Array.from({ length: MAX_EXTRACTION_CANDIDATES }, (_, index) => `- Point ${index + 1}.`).join("\n");

    expect(candidatesOf(response)).toHaveLength(MAX_EXTRACTION_CANDIDATES);
  });

  test("skips a response with more candidates than the limit", () => {
    const response = Array.from({ length: MAX_EXTRACTION_CANDIDATES + 1 }, (_, index) => `- Point ${index + 1}.`).join("\n");

    expect(parseReviewCandidates(response)).toEqual({ skipped: true, reason: "too_many_candidates" });
  });

  test("accepts a candidate of exactly the maximum length", () => {
    const line = "x".repeat(MAX_CANDIDATE_CHARACTERS);

    expect(texts(`- ${line}`)).toEqual([line]);
  });

  test("skips a response with a candidate over the length limit", () => {
    expect(parseReviewCandidates(`- ${"x".repeat(MAX_CANDIDATE_CHARACTERS + 1)}`))
      .toEqual({ skipped: true, reason: "candidate_too_long" });
  });

  test("measures a wrapped item's length after joining", () => {
    const half = "y".repeat(MAX_CANDIDATE_CHARACTERS / 2 + 10);

    expect(parseReviewCandidates(`- ${half}\n  ${half}`)).toEqual({ skipped: true, reason: "candidate_too_long" });
  });

  test("skips rather than truncates a response over the byte cap", () => {
    const response = `- Point.\n${"z\n".repeat(MAX_EXTRACTION_RESPONSE_BYTES)}`;

    expect(parseReviewCandidates(response)).toEqual({ skipped: true, reason: "response_too_large" });
  });
});
