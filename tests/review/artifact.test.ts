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