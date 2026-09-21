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

/**
 * Provenance of a review recovered from the reviewer's own prose rather than parsed from its
 * structured response. It names the judgment decision record that classified the reviewer's
 * lines. Absent on every review the reviewer returned in the required shape, including every
 * artifact written before extraction existed.
 */
export const reviewExtractionMarkSchema = z
  .object({
    recordId: singleLine.refine((value) => !value.includes("`"), {
      message: "Expected a value without backticks",
    }),
  })
  .strict();

export type ReviewExtractionMark = z.infer<typeof reviewExtractionMarkSchema>;

/**
 * Provenance of an approval that was carried forward across an edit instead of being reviewed
 * again. The verdict, the recommendations, and the reviewing model stay those of the real review
 * that approved; these marks say how that approval reached the current digest: which review it
 * came from, how many carry-forwards in a row this is, the judgment decision record that allowed
 * it, and the judged answers as evidence. Absent on every full review, including every artifact
 * written before triage existed.
 */
export const reviewCarryForwardMarkSchema = z
  .object({
    /** The artifact digest of the full review whose approval this carries. */
    basisDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** Consecutive carry-forwards since that full review, this one included. */
    count: z.number().int().positive(),
    recordId: singleLine.refine((value) => !value.includes("`"), {
      message: "Expected a value without backticks",
    }),
    /** What the judgment answered, one line per answer. */
    evidence: z.array(singleLine),
  })
  .strict();

export type ReviewCarryForwardMark = z.infer<typeof reviewCarryForwardMarkSchema>;

/**
 * What a lint approval records instead of a reviewer's reading: the deterministic checks that
 * ran, whether the semantic check ran, and its answers, one line each. Present only on a review
 * whose mode is lint.
 */
export const reviewLintRecordSchema = z
  .object({
    checks: z.array(singleLine).min(1),
    /** `ran`, or why it did not: the service was unavailable, or the plan was too large to ask about. */
    semanticCheck: z.enum(["ran", "unavailable", "skipped"]),
    answers: z.array(singleLine),
  })
  .strict();

export type ReviewLintRecord = z.infer<typeof reviewLintRecordSchema>;

/** Who approved the plan: an independent reviewer model, or the deterministic lint (small lane only). */
export const REVIEW_MODES = ["reviewer", "lint"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const planningReviewArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** A review file written before modes existed has none, and is a reviewer review. */
    mode: z.enum(REVIEW_MODES).default("reviewer"),
    round: z.number().int().positive(),
    reviewedAt: z.string().datetime({ offset: true }),
    model: singleLine,
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: z.enum(["APPROVE", "REVISE"]),
    criticalFindings: z.array(singleLine),
    requiredChanges: z.array(singleLine),
    recommendations: z.array(singleLine),
    extraction: reviewExtractionMarkSchema.optional(),
    carriedForward: reviewCarryForwardMarkSchema.optional(),
    lint: reviewLintRecordSchema.optional(),
  })
  .strict()
  .superRefine(refineVerdictConsistency)
  .superRefine((review, context) => {
    if (review.mode === "lint") {
      if (!review.lint) context.addIssue({ code: "custom", path: ["lint"], message: "A lint review must record its checks" });
      if (review.model !== "lint") context.addIssue({ code: "custom", path: ["model"], message: "A lint review names lint as its model" });
      if (review.verdict !== "APPROVE") context.addIssue({ code: "custom", path: ["verdict"], message: "A lint review only ever approves" });
      if (review.extraction || review.carriedForward) {
        context.addIssue({ code: "custom", path: ["mode"], message: "A lint review has no reviewer to extract from or carry forward" });
      }
    } else if (review.lint) {
      context.addIssue({ code: "custom", path: ["lint"], message: "Only a lint review records lint checks" });
    }
  })
  .superRefine((review, context) => {
    if (review.carriedForward && review.extraction) {
      context.addIssue({
        code: "custom",
        path: ["carriedForward"],
        message: "A carried-forward review cannot also be an extracted review",
      });
    }
  });

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

export interface CreateReviewArtifactInput extends Omit<PlanningReviewArtifact, "verdict" | "mode"> {
  /** A reviewer review when omitted. */
  mode?: ReviewMode;
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
    ...(input.mode ? { mode: input.mode } : {}),
    round: input.round,
    reviewedAt: input.reviewedAt,
    model: input.model,
    artifactDigest: input.artifactDigest,
    verdict: blocking ? "REVISE" : input.requestedVerdict,
    criticalFindings: input.criticalFindings,
    requiredChanges: input.requiredChanges,
    recommendations: input.recommendations,
    ...(input.extraction ? { extraction: input.extraction } : {}),
    ...(input.carriedForward ? { carriedForward: input.carriedForward } : {}),
    ...(input.lint ? { lint: input.lint } : {}),
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
    `- Mode: \`${valid.mode}\``,
    `- Round: \`${valid.round}\``,
    `- Reviewed at: \`${valid.reviewedAt}\``,
    `- Model: \`${valid.model}\``,
    `- Artifact digest: \`${valid.artifactDigest}\``,
    `- Verdict: \`${valid.verdict}\``,
    ...(valid.lint ? [`- Semantic check: \`${valid.lint.semanticCheck}\``] : []),
    ...(valid.extraction ? [`- Extraction record: \`${valid.extraction.recordId}\``] : []),
    ...(valid.carriedForward
      ? [
        `- Carried forward from: \`${valid.carriedForward.basisDigest}\``,
        `- Carry-forward count: \`${valid.carriedForward.count}\``,
        `- Carry-forward record: \`${valid.carriedForward.recordId}\``,
      ]
      : []),
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
    ...(valid.carriedForward
      ? ["## Carry-Forward Evidence", "", renderList(valid.carriedForward.evidence), ""]
      : []),
    ...(valid.lint
      ? [
        "## Lint Checks",
        "",
        renderList(valid.lint.checks),
        "",
        "## Semantic Check Answers",
        "",
        renderList(valid.lint.answers),
        "",
      ]
      : []),
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

/** Like `metadataValue`, but a missing field is `undefined` rather than an error. */
function optionalMetadataValue(
  lines: readonly string[],
  label: string,
  path: string,
): string | undefined {
  const present = lines.some((line) => line.startsWith(`- ${label}: `));
  return present ? metadataValue(lines, label, path) : undefined;
}

const CARRY_FORWARD_LABELS = ["Carried forward from", "Carry-forward count", "Carry-forward record"] as const;
const CARRY_FORWARD_HEADING = "## Carry-Forward Evidence";

/**
 * The carry-forward marks, or undefined for a full review. The marks come together or not at
 * all: a partial set is a corrupt artifact, not a full review.
 */
function carryForwardMark(lines: readonly string[], path: string): ReviewCarryForwardMark | undefined {
  const present = CARRY_FORWARD_LABELS.filter((label) => lines.some((line) => line.startsWith(`- ${label}: `)));
  const hasSection = lines.includes(CARRY_FORWARD_HEADING);
  if (present.length === 0) {
    if (hasSection) return invalidReview("Carry-forward evidence has no carry-forward marks", path);
    return undefined;
  }
  return {
    basisDigest: metadataValue(lines, "Carried forward from", path),
    count: Number(metadataValue(lines, "Carry-forward count", path)),
    recordId: metadataValue(lines, "Carry-forward record", path),
    evidence: sectionValues(lines, CARRY_FORWARD_HEADING, path),
  };
}

const LINT_CHECKS_HEADING = "## Lint Checks";

/** The lint record of a lint review, or undefined for a reviewer review. */
function lintRecord(lines: readonly string[], path: string): ReviewLintRecord | undefined {
  if (!lines.includes(LINT_CHECKS_HEADING)) return undefined;
  return {
    checks: sectionValues(lines, LINT_CHECKS_HEADING, path),
    semanticCheck: metadataValue(lines, "Semantic check", path) as ReviewLintRecord["semanticCheck"],
    answers: sectionValues(lines, "## Semantic Check Answers", path),
  };
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

  const extractionRecord = optionalMetadataValue(lines, "Extraction record", path);
  const carriedForward = carryForwardMark(lines, path);
  const mode = optionalMetadataValue(lines, "Mode", path);
  const lint = lintRecord(lines, path);
  return validateReview({
    schemaVersion: Number(metadataValue(lines, "Schema version", path)),
    ...(mode === undefined ? {} : { mode }),
    round: Number(metadataValue(lines, "Round", path)),
    reviewedAt: metadataValue(lines, "Reviewed at", path),
    model: metadataValue(lines, "Model", path),
    artifactDigest: metadataValue(lines, "Artifact digest", path),
    verdict: metadataValue(lines, "Verdict", path),
    criticalFindings: sectionValues(lines, "## Critical Findings", path),
    requiredChanges: sectionValues(lines, "## Required Changes", path),
    recommendations: sectionValues(lines, "## Recommendations", path),
    ...(extractionRecord === undefined ? {} : { extraction: { recordId: extractionRecord } }),
    ...(carriedForward === undefined ? {} : { carriedForward }),
    ...(lint === undefined ? {} : { lint }),
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