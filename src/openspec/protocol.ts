import { z, type ZodType } from "zod";
import { HarnessError } from "../shared/errors.ts";

const nonEmptyString = z.string().min(1);
const nonnegativeInteger = z.number().int().nonnegative();

const rootSchema = z
  .object({
    path: nonEmptyString,
    source: nonEmptyString,
    role: nonEmptyString.optional(),
  })
  .passthrough();

const planningHomeSchema = z
  .object({
    kind: nonEmptyString,
    root: nonEmptyString,
    changesDir: nonEmptyString,
    defaultSchema: nonEmptyString,
  })
  .passthrough();

const artifactPathSchema = z
  .object({
    outputPath: nonEmptyString,
    resolvedOutputPath: nonEmptyString,
    existingOutputPaths: z.array(nonEmptyString),
  })
  .passthrough();

export const openSpecContextSchema = z
  .object({
    root: rootSchema,
    members: z.array(z.unknown()),
    status: z.array(z.unknown()),
  })
  .passthrough();

export const openSpecStatusSchema = z
  .object({
    changeName: nonEmptyString,
    schemaName: nonEmptyString,
    planningHome: planningHomeSchema,
    changeRoot: nonEmptyString,
    artifactPaths: z.record(nonEmptyString, artifactPathSchema),
    isPlanningComplete: z.boolean(),
    isComplete: z.boolean(),
    applyRequires: z.array(nonEmptyString),
    nextSteps: z.array(z.string()),
    actionContext: z
      .object({
        mode: nonEmptyString,
        sourceOfTruth: nonEmptyString,
        planningArtifacts: z.array(nonEmptyString),
        linkedContext: z.array(z.unknown()),
        allowedEditRoots: z.array(nonEmptyString),
        requiresAffectedAreaSelection: z.boolean(),
        constraints: z.array(z.string()),
      })
      .passthrough(),
    artifacts: z.array(
      z
        .object({
          id: nonEmptyString,
          outputPath: nonEmptyString,
          status: nonEmptyString,
          requires: z.array(nonEmptyString),
        })
        .passthrough(),
    ),
    root: rootSchema,
  })
  .passthrough();

export const openSpecInstructionsSchema = z
  .object({
    changeName: nonEmptyString,
    artifactId: nonEmptyString,
    schemaName: nonEmptyString,
    changeDir: nonEmptyString,
    planningHome: planningHomeSchema,
    outputPath: nonEmptyString,
    resolvedOutputPath: nonEmptyString,
    existingOutputPaths: z.array(nonEmptyString),
    description: z.string(),
    instruction: z.string(),
    template: z.string(),
    dependencies: z.array(nonEmptyString),
    unlocks: z.array(nonEmptyString),
    root: rootSchema,
  })
  .passthrough();

export const openSpecApplySchema = z
  .object({
    changeName: nonEmptyString,
    changeDir: nonEmptyString,
    schemaName: nonEmptyString,
    contextFiles: z.record(nonEmptyString, z.array(nonEmptyString)),
    progress: z
      .object({
        total: nonnegativeInteger,
        complete: nonnegativeInteger,
        remaining: nonnegativeInteger,
      })
      .refine(
        ({ total, complete, remaining }) => complete + remaining === total,
        "complete plus remaining must equal total",
      ),
    tasks: z.array(
      z.object({
        id: nonEmptyString,
        description: nonEmptyString,
        done: z.boolean(),
      }),
    ),
    state: z.enum(["ready", "blocked", "all_done"]),
    instruction: z.string(),
    context: z.unknown().optional(),
    operationGuidance: z.unknown().optional(),
    root: rootSchema,
  })
  .passthrough();

const validationCountsSchema = z.object({
  items: nonnegativeInteger,
  passed: nonnegativeInteger,
  failed: nonnegativeInteger,
});

export const openSpecValidateSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: nonEmptyString,
          type: nonEmptyString,
          valid: z.boolean(),
          issues: z.array(z.unknown()),
          durationMs: nonnegativeInteger.optional(),
        })
        .passthrough(),
    ),
    summary: z.object({
      totals: validationCountsSchema,
      byType: z.record(nonEmptyString, validationCountsSchema),
    }),
    version: nonEmptyString,
    root: rootSchema,
  })
  .passthrough();

export const openSpecArchiveSchema = z
  .object({
    archive: z
      .object({
        change: nonEmptyString,
        archivedAs: nonEmptyString,
        path: nonEmptyString,
        specsUpdated: z.array(nonEmptyString),
        totals: z.record(nonEmptyString, z.unknown()).optional(),
        warnings: z.array(z.unknown()).optional(),
      })
      .passthrough(),
    root: rootSchema,
  })
  .passthrough();

export const openSpecSchemas = {
  context: openSpecContextSchema,
  status: openSpecStatusSchema,
  instructions: openSpecInstructionsSchema,
  apply: openSpecApplySchema,
  validate: openSpecValidateSchema,
  archive: openSpecArchiveSchema,
} as const;

export function parseOpenSpecJson<TSchema extends ZodType>(
  command: string,
  output: string,
  schema: TSchema,
): z.output<TSchema> {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch (cause) {
    throw new HarnessError(
      "OPENSPEC_INVALID_JSON",
      `OpenSpec ${command} returned invalid JSON`,
      { command },
      { cause },
    );
  }

  const result = schema.safeParse(payload);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.map(String).join(".") || "<root>",
  }));
  throw new HarnessError(
    "OPENSPEC_SCHEMA_MISMATCH",
    `OpenSpec ${command} returned an incompatible payload at ${issues[0]?.path ?? "<root>"}`,
    { command, issues },
  );
}

export type OpenSpecContext = z.infer<typeof openSpecContextSchema>;
export type OpenSpecStatus = z.infer<typeof openSpecStatusSchema>;
export type OpenSpecInstructions = z.infer<typeof openSpecInstructionsSchema>;
export type OpenSpecApplyInstructions = z.infer<typeof openSpecApplySchema>;
export type OpenSpecValidation = z.infer<typeof openSpecValidateSchema>;
export type OpenSpecArchive = z.infer<typeof openSpecArchiveSchema>;