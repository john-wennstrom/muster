import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JudgmentAnswers } from "../../src/judgment/client.ts";
import { reviewExtractionDecision } from "../../src/judgment/decisions/review-extraction.ts";
import { reviewExtractionLineQuestionId } from "../../src/judgment/questions.ts";
import { planningReviewSubmissionSchema } from "../../src/review/review-artifact.ts";
import { assembleReviewSubmission, parseReviewCandidates } from "../../src/review/review-extraction.ts";

/**
 * Replays a corpus of reviewer responses through the candidate parser, the decision's gate, and
 * the assembly, and checks each against its expected structure. The responses are written to
 * the shapes reviewers produce (bullets, numbered lists, wrapped lines, paragraphs, headings,
 * contradictions, narration); they are not captured from live reviewer sessions. The recorded
 * classification is what the service is expected to answer for each response, so this checks
 * the code around the service deterministically, not the service itself. Agreement between the
 * live service and a retry is measured by the shadow-mode report, not here.
 */

const DIRECTORY = resolve(import.meta.dir, "data/review-extraction");

interface CorpusEntry {
  name: string;
  response: string;
  candidates: Array<{ text: string; heading: string | null }> | { skipped: string };
  answers?: {
    verdict: { choice: string; confidence: number };
    lines: Array<{ choice: string; confidence: number }>;
  };
  expected: {
    accepted: boolean;
    abstainReason?: string;
    review?: {
      verdict: "APPROVE" | "REVISE";
      criticalFindings: string[];
      requiredChanges: string[];
      recommendations: string[];
    };
  };
}

const corpus: CorpusEntry[] = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(resolve(DIRECTORY, name), "utf8")) as CorpusEntry);

function answersOf(entry: CorpusEntry): JudgmentAnswers {
  const recorded = entry.answers!;
  const answers: Record<string, JudgmentAnswers[string]> = {
    verdict: {
      type: "choice",
      choice: recorded.verdict.choice,
      probabilities: { [recorded.verdict.choice]: recorded.verdict.confidence },
      confidence: recorded.verdict.confidence,
    },
  };
  recorded.lines.forEach(({ choice, confidence }, position) => {
    answers[reviewExtractionLineQuestionId(position + 1)] = {
      type: "choice",
      choice,
      probabilities: { [choice]: confidence },
      confidence,
    };
  });
  return answers;
}

describe("review extraction corpus", () => {
  test("covers each response shape, an acceptance and a rejection of each kind, and both limits", () => {
    const names = corpus.map(({ name }) => name);

    expect(corpus.length).toBeGreaterThanOrEqual(12);
    expect(new Set(names).size).toBe(names.length);
    expect(corpus.filter(({ expected }) => expected.accepted).length).toBeGreaterThanOrEqual(6);
    expect(corpus.filter(({ expected }) => !expected.accepted).length).toBeGreaterThanOrEqual(6);
    expect(names).toEqual(expect.arrayContaining([
      "bulleted-sections-revise",
      "numbered-findings-revise",
      "wrapped-lines-revise",
      "paragraph-form-revise",
      "empty-response",
      "too-many-candidates-skipped",
      "overlong-line-skipped",
    ]));
    const verdicts = corpus.flatMap(({ expected }) => expected.review ? [expected.review.verdict] : []);
    expect(verdicts).toContain("APPROVE");
    expect(verdicts).toContain("REVISE");
  });

  for (const entry of corpus) {
    describe(entry.name, () => {
      const parsed = parseReviewCandidates(entry.response);

      test("the parser finds the expected candidates", () => {
        if (!Array.isArray(entry.candidates)) {
          expect(parsed).toEqual({ skipped: true, reason: entry.candidates.skipped as never });
          return;
        }
        expect(parsed.skipped).toBeFalse();
        if (parsed.skipped) return;
        expect(parsed.candidates.map(({ text, heading }) => ({ text, heading }))).toEqual(entry.candidates);
      });

      test("the decision and assembly produce the expected structure", () => {
        if (parsed.skipped || parsed.candidates.length === 0) {
          expect(entry.expected.accepted).toBeFalse();
          expect(entry.answers).toBeUndefined();
          return;
        }
        expect(entry.answers?.lines).toHaveLength(parsed.candidates.length);
        const outcome = reviewExtractionDecision.gate(answersOf(entry));

        if (!entry.expected.accepted) {
          expect(outcome.act).toBeFalse();
          if (!outcome.act) expect(outcome.reason).toContain(entry.expected.abstainReason!);
          return;
        }
        expect(outcome.act).toBeTrue();
        if (!outcome.act) return;
        const assembled = assembleReviewSubmission(parsed.candidates, outcome.value);
        expect(assembled.ok).toBeTrue();
        if (!assembled.ok) return;
        expect(assembled.submission).toEqual(entry.expected.review!);
        expect(planningReviewSubmissionSchema.safeParse(assembled.submission).success).toBeTrue();
        const lines = new Set(parsed.candidates.map(({ text }) => text));
        for (const finding of [
          ...assembled.submission.criticalFindings,
          ...assembled.submission.requiredChanges,
          ...assembled.submission.recommendations,
        ]) expect(lines.has(finding)).toBeTrue();
      });
    });
  }
});
