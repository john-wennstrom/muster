import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { HarnessError } from "../shared/errors.ts";

const singleLine = z.string().min(1).refine((value) => !/[\r\n]/.test(value), {
  message: "Expected a single line",
});

function refineVerdictConsistency<T extends { verdict: "APPROVE" | "REVISE"; criticalFindings: string[]; requiredChanges: string[] }>(
  review: T,
  context: z.RefinementCtx,
): void {
  if (
    review.verdict === "APPROVE" &&
    (review.criticalFindings.length > 0 || review.requiredChanges.length > 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["verdict"],
      message: "APPROVE cannot include critical findings or required changes",
    });
  }
}

export const planningReviewArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    round: z.number().int().positive(),
    reviewedAt: z.string().datetime({ offset: true }),
    model: singleLine,
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: z.enum(["APPROVE", "REVISE"]),
    criticalFindings: z.array(singleLine),
    requiredChanges: z.array(singleLine),
    recommendations: z.array(singleLine),
  })
  .strict()
  .superRefine(refineVerdictConsistency);

export type PlanningReviewArtifact = z.infer<typeof planningReviewArtifactSchema>;

/**
 * What a reviewer model can actually be expected to produce: a verdict and
 * findings. `schemaVersion`/`round`/`reviewedAt`/`model`/`artifactDigest` on
 * `planningReviewArtifactSchema` are controller-owned bookkeeping — reviewChange
 * (controller/review.ts) fills them in itself and never reads them back from
 * the model's response, so requiring the model to fabricate them (a digest
 * hash, an exact-format timestamp, its own model id) only produces avoidable
 * validation failures. Unknown fields are stripped, not rejected: a model
 * that adds extra commentary shouldn't fail the review over it.
 */
export const planningReviewSubmissionSchema = z
  .object({
    verdict: z.enum(["APPROVE", "REVISE"]),
    criticalFindings: z.array(singleLine),
    requiredChanges: z.array(singleLine),
    recommendations: z.array(singleLine),
  })
  .superRefine(refineVerdictConsistency);

export type PlanningReviewSubmission = z.infer<typeof planningReviewSubmissionSchema>;

export interface CreateReviewArtifactInput extends Omit<PlanningReviewArtifact, "verdict"> {
  requestedVerdict: PlanningReviewArtifact["verdict"];
}

export interface ReviewArtifactWriteHooks {
  beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void> | void;
}

function invalidReview(
  message: string,
  path: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new HarnessError(
    "REVIEW_ARTIFACT_INVALID",
    `${message}: ${path}`,
    { path, ...details },
    cause === undefined ? undefined : { cause },
  );
}

function validateReview(payload: unknown, path: string): PlanningReviewArtifact {
  const result = planningReviewArtifactSchema.safeParse(payload);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.map(String).join(".") || "<root>",
  }));
  return invalidReview(
    `Planning review is incompatible at ${issues[0]?.path ?? "<root>"}`,
    path,
    { issues },
  );
}

export function createReviewArtifact(
  input: CreateReviewArtifactInput,
): PlanningReviewArtifact {
  const blocking = input.criticalFindings.length > 0 || input.requiredChanges.length > 0;
  return validateReview({
    schemaVersion: input.schemaVersion,
    round: input.round,
    reviewedAt: input.reviewedAt,
    model: input.model,
    artifactDigest: input.artifactDigest,
    verdict: blocking ? "REVISE" : input.requestedVerdict,
    criticalFindings: input.criticalFindings,
    requiredChanges: input.requiredChanges,
    recommendations: input.recommendations,
  }, "review.md");
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? "_None._" : values.map((value) => `- ${value}`).join("\n");
}

export function renderReviewArtifact(review: PlanningReviewArtifact): string {
  const valid = validateReview(review, "review.md");
  return [
    "# Planning Review",
    "",
    `- Schema version: \`${valid.schemaVersion}\``,
    `- Round: \`${valid.round}\``,
    `- Reviewed at: \`${valid.reviewedAt}\``,
    `- Model: \`${valid.model}\``,
    `- Artifact digest: \`${valid.artifactDigest}\``,
    `- Verdict: \`${valid.verdict}\``,
    "",
    "## Critical Findings",
    "",
    renderList(valid.criticalFindings),
    "",
    "## Required Changes",
    "",
    renderList(valid.requiredChanges),
    "",
    "## Recommendations",
    "",
    renderList(valid.recommendations),
    "",
  ].join("\n");
}

function metadataValue(lines: readonly string[], label: string, path: string): string {
  const prefix = `- ${label}: `;
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) {
    return invalidReview(`Expected exactly one ${label} field`, path, {
      label,
      count: matches.length,
    });
  }
  const value = matches[0]!.slice(prefix.length).trim();
  if (!value.startsWith("`") || !value.endsWith("`") || value.length < 3) {
    return invalidReview(`${label} must contain one backtick-delimited value`, path, { label });
  }
  return value.slice(1, -1);
}

function sectionValues(lines: readonly string[], heading: string, path: string): string[] {
  const indexes = lines.flatMap((line, index) => line === heading ? [index] : []);
  if (indexes.length !== 1) {
    return invalidReview(`Expected exactly one ${heading} section`, path, {
      heading,
      count: indexes.length,
    });
  }
  const start = indexes[0]! + 1;
  const nextHeading = lines.findIndex((line, index) => index >= start && line.startsWith("## "));
  const content = lines.slice(start, nextHeading === -1 ? lines.length : nextHeading)
    .map((line) => line.trim())
    .filter(Boolean);
  if (content.length === 1 && content[0] === "_None._") return [];
  if (content.some((line) => !line.startsWith("- ") || line.length === 2)) {
    return invalidReview(`${heading} entries must be non-empty Markdown list items`, path, {
      heading,
    });
  }
  return content.map((line) => line.slice(2));
}

export function parseReviewArtifact(contents: string, path: string): PlanningReviewArtifact {
  const lines = contents.split(/\r?\n/);
  if (lines.filter((line) => line === "# Planning Review").length !== 1) {
    return invalidReview("Expected Planning Review title", path);
  }

  return validateReview({
    schemaVersion: Number(metadataValue(lines, "Schema version", path)),
    round: Number(metadataValue(lines, "Round", path)),
    reviewedAt: metadataValue(lines, "Reviewed at", path),
    model: metadataValue(lines, "Model", path),
    artifactDigest: metadataValue(lines, "Artifact digest", path),
    verdict: metadataValue(lines, "Verdict", path),
    criticalFindings: sectionValues(lines, "## Critical Findings", path),
    requiredChanges: sectionValues(lines, "## Required Changes", path),
    recommendations: sectionValues(lines, "## Recommendations", path),
  }, path);
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  }
}

export async function writeReviewArtifact(
  path: string,
  review: PlanningReviewArtifact,
  hooks: ReviewArtifactWriteHooks = {},
): Promise<void> {
  const targetPath = resolve(path);
  const targetDirectory = dirname(targetPath);
  const temporaryPath = resolve(
    targetDirectory,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(targetDirectory, { recursive: true });

  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(renderReviewArtifact(review), "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await hooks.beforeRename?.(temporaryPath, targetPath);
    await rename(temporaryPath, targetPath);
    await syncDirectory(targetDirectory);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}