import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createReviewArtifact,
  parseReviewArtifact,
  renderReviewArtifact,
  writeReviewArtifact,
} from "../../src/review/review-artifact.ts";
import { HarnessError } from "../../src/shared/errors.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function approved() {
  return createReviewArtifact({
    schemaVersion: 1,
    round: 1,
    reviewedAt: "2026-09-12T12:00:00.000Z",
    model: "openai/reviewer",
    artifactDigest: "a".repeat(64),
    requestedVerdict: "APPROVE",
    criticalFindings: [],
    requiredChanges: [],
    recommendations: ["Keep the focused recovery test."],
  });
}

describe("planning review artifact", () => {
  test("round trips the durable markdown contract", () => {
    const artifact = approved();
    const markdown = renderReviewArtifact(artifact);

    expect(parseReviewArtifact(markdown, "review.md")).toEqual(artifact);
    expect(markdown).toContain("- Verdict: `APPROVE`");
    expect(markdown).not.toContain("<!--");
  });

  test("round trips an extraction mark naming the decision record", () => {
    const artifact = createReviewArtifact({
      ...approved(),
      requestedVerdict: "APPROVE",
      extraction: { recordId: "decision-1234" },
    });
    const markdown = renderReviewArtifact(artifact);

    expect(markdown).toContain("- Extraction record: `decision-1234`");
    expect(markdown.split("\n").filter((line) => line.startsWith("- Extraction record:"))).toHaveLength(1);
    const parsed = parseReviewArtifact(markdown, "review.md");
    expect(parsed).toEqual(artifact);
    expect(parsed.extraction).toEqual({ recordId: "decision-1234" });
    expect(parsed.verdict).toBe("APPROVE");
    expect(parsed.artifactDigest).toBe("a".repeat(64));
  });

  test("an artifact written before extraction existed parses as not extracted", () => {
    const legacy = [
      "# Planning Review",
      "",
      "- Schema version: `1`",
      "- Round: `2`",
      "- Reviewed at: `2026-09-12T12:00:00.000Z`",
      "- Model: `openai/reviewer`",
      `- Artifact digest: \`${"b".repeat(64)}\``,
      "- Verdict: `REVISE`",
      "",
      "## Critical Findings",
      "",
      "_None._",
      "",
      "## Required Changes",
      "",
      "- Add the missing failure scenario.",
      "",
      "## Recommendations",
      "",
      "_None._",
      "",
    ].join("\n");

    const parsed = parseReviewArtifact(legacy, "review.md");
    expect(parsed.extraction).toBeUndefined();
    expect(parsed.requiredChanges).toEqual(["Add the missing failure scenario."]);
  });

  test("an artifact without a mark renders exactly as before", () => {
    const markdown = renderReviewArtifact(approved());

    expect(markdown).not.toContain("Extraction record");
    expect("extraction" in approved()).toBe(false);
  });

  test("rejects a repeated or malformed extraction line", () => {
    const marked = renderReviewArtifact(createReviewArtifact({
      ...approved(),
      requestedVerdict: "APPROVE",
      extraction: { recordId: "decision-1234" },
    }));
    const repeated = marked.replace(
      "- Extraction record: `decision-1234`",
      "- Extraction record: `decision-1234`\n- Extraction record: `decision-5678`",
    );
    const unquoted = marked.replace("`decision-1234`", "decision-1234");

    for (const markdown of [repeated, unquoted]) {
      expect(() => parseReviewArtifact(markdown, "review.md")).toThrow(
        expect.objectContaining({ code: "REVIEW_ARTIFACT_INVALID" }) as HarnessError,
      );
    }
  });

  const carried = () => createReviewArtifact({
    ...approved(),
    round: 2,
    requestedVerdict: "APPROVE",
    carriedForward: {
      basisDigest: "c".repeat(64),
      count: 2,
      recordId: "decision-9999",
      evidence: ["materiality: 0.4 (confidence 0.95)", "requirement_change: 0.05"],
    },
  });

  test("round trips carry-forward marks and the judged evidence", () => {
    const artifact = carried();
    const markdown = renderReviewArtifact(artifact);

    expect(markdown).toContain(`- Carried forward from: \`${"c".repeat(64)}\``);
    expect(markdown).toContain("- Carry-forward count: `2`");
    expect(markdown).toContain("- Carry-forward record: `decision-9999`");
    expect(markdown).toContain("## Carry-Forward Evidence");
    const parsed = parseReviewArtifact(markdown, "review.md");
    expect(parsed).toEqual(artifact);
    expect(parsed.verdict).toBe("APPROVE");
    expect(parsed.artifactDigest).toBe("a".repeat(64));
    expect(parsed.model).toBe("openai/reviewer");
    expect(parsed.recommendations).toEqual(["Keep the focused recovery test."]);
  });

  test("a carried-forward artifact with no evidence lines round trips", () => {
    const artifact = createReviewArtifact({
      ...approved(),
      requestedVerdict: "APPROVE",
      carriedForward: { basisDigest: "c".repeat(64), count: 1, recordId: "decision-1", evidence: [] },
    });
    expect(parseReviewArtifact(renderReviewArtifact(artifact), "review.md")).toEqual(artifact);
  });

  test("an artifact written before triage existed parses as a full review", () => {
    const legacy = renderReviewArtifact(approved());
    expect(legacy).not.toContain("Carr");
    expect(parseReviewArtifact(legacy, "review.md").carriedForward).toBeUndefined();
    expect("carriedForward" in approved()).toBe(false);
  });

  test("rejects a partial or orphaned set of carry-forward marks", () => {
    const marked = renderReviewArtifact(carried());
    const withoutCount = marked.replace("- Carry-forward count: `2`\n", "");
    const withoutSection = marked.replace(/## Carry-Forward Evidence[\s\S]*$/, "");
    const orphanedSection = renderReviewArtifact(approved()) + "\n## Carry-Forward Evidence\n\n_None._\n";
    const repeated = marked.replace(
      "- Carry-forward count: `2`",
      "- Carry-forward count: `2`\n- Carry-forward count: `3`",
    );

    for (const markdown of [withoutCount, withoutSection, orphanedSection, repeated]) {
      expect(() => parseReviewArtifact(markdown, "review.md")).toThrow(
        expect.objectContaining({ code: "REVIEW_ARTIFACT_INVALID" }) as HarnessError,
      );
    }
  });

  test("a review cannot be both extracted and carried forward", () => {
    expect(() => createReviewArtifact({
      ...carried(),
      requestedVerdict: "APPROVE",
      extraction: { recordId: "decision-1" },
    })).toThrow(expect.objectContaining({ code: "REVIEW_ARTIFACT_INVALID" }) as HarnessError);
  });

  test("forces REVISE when the reviewer reports a required correction", () => {
    const artifact = createReviewArtifact({
      ...approved(),
      requestedVerdict: "APPROVE",
      requiredChanges: ["Add the missing failure scenario."],
    });

    expect(artifact.verdict).toBe("REVISE");
  });

  test("rejects unsupported verdicts", () => {
    const markdown = renderReviewArtifact(approved()).replace("`APPROVE`", "`APPROVE_WITH_CHANGES`");

    expect(() => parseReviewArtifact(markdown, "review.md")).toThrow(
      expect.objectContaining({ code: "REVIEW_ARTIFACT_INVALID" }) as HarnessError,
    );
  });

  test("atomically preserves the previous review when replacement is interrupted", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "muster-review-artifact-"));
    temporaryDirectories.push(root);
    const path = resolve(root, "review.md");
    const previous = approved();
    await writeReviewArtifact(path, previous);

    await expect(writeReviewArtifact(path, {
      ...previous,
      round: 2,
      verdict: "REVISE",
      requiredChanges: ["Revise the design."],
    }, {
      beforeRename: () => {
        throw new Error("injected interruption");
      },
    })).rejects.toThrow("injected interruption");

    expect(parseReviewArtifact(await readFile(path, "utf8"), path)).toEqual(previous);
  });
});