import { z } from "zod";
import { HarnessError } from "../shared/errors.ts";

const nonEmptyString = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const version = z.literal(1);

export const manualActionCategorySchema = z.enum([
  "authentication",
  "elevated_permission",
  "destructive",
  "external_side_effect",
  "design_decision",
]);

export const runManifestSchema = z
  .object({
    schemaVersion: version,
    runId: nonEmptyString,
    changeName: nonEmptyString,
    lifecycle: z.enum([
      "EXPLORE",
      "PLANNING",
      "REVIEW_REQUIRED",
      "READY",
      "IMPLEMENTING",
      "VERIFYING",
      "VERIFIED",
      "FINISHING",
      "COMPLETE",
      "AWAITING_USER",
      "DESIGN_CONFLICT",
      "BLOCKED",
      "FAILED",
      "CANCELLED",
    ]),
    repository: z.object({
      id: nonEmptyString,
      commonDirectory: nonEmptyString,
    }),
    worktree: z.object({
      path: nonEmptyString,
      head: nonEmptyString,
      indexDigest: nonEmptyString,
      diffDigest: nonEmptyString,
    }),
    artifactDigest: nonEmptyString.nullable(),
    tasks: z.record(
      nonEmptyString,
      z.enum([
        "blocked",
        "ready",
        "running",
        "awaiting_user",
        "design_conflict",
        "debugging",
        "failed",
        "completed",
        "cancelled",
      ]),
    ),
    modelAssignments: z.record(nonEmptyString, nonEmptyString),
    writer: z
      .object({
        processId: z.number().int().positive(),
        runId: nonEmptyString,
        taskId: nonEmptyString,
        command: nonEmptyString,
        acquiredAt: timestamp,
      })
      .nullable(),
    checkpoints: z.array(nonEmptyString),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const taskResultSchema = z
  .object({
    schemaVersion: version,
    runId: nonEmptyString,
    taskId: nonEmptyString,
    outcome: z.enum(["completed", "blocked", "awaiting_user", "design_conflict"]),
    sourceDigest: nonEmptyString,
    verificationEvidence: z.array(nonEmptyString),
    completedAt: timestamp,
  })
  .strict();

export const reviewRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: version,
      runId: nonEmptyString,
      kind: z.literal("planning"),
      verdict: z.enum(["APPROVE", "REVISE"]),
      artifactDigest: nonEmptyString,
      model: nonEmptyString,
      findings: z.array(z.string()),
      createdAt: timestamp,
    })
    .strict(),
  z
    .object({
    schemaVersion: version,
    runId: nonEmptyString,
    taskId: nonEmptyString,
    kind: z.literal("task"),
    verdict: z.enum(["APPROVE", "REVISE"]),
    artifactDigest: nonEmptyString,
    model: nonEmptyString,
    findings: z.array(z.string()),
    createdAt: timestamp,
  })
    .strict(),
]);

export const validationRecordSchema = z
  .object({
    schemaVersion: version,
    runId: nonEmptyString,
    result: z.enum(["PASS", "FAIL"]),
    sourceDigest: nonEmptyString,
    artifactDigest: nonEmptyString,
    commands: z.array(
      z.object({
        command: nonEmptyString,
        exitCode: z.number().int(),
      }),
    ),
    createdAt: timestamp,
  })
  .strict();

export const checkpointRecordSchema = z
  .object({
    schemaVersion: version,
    id: nonEmptyString,
    runId: nonEmptyString,
    changeName: nonEmptyString,
    taskId: nonEmptyString,
    branch: z.array(nonEmptyString).min(1),
    category: manualActionCategorySchema,
    reason: nonEmptyString,
    instructions: z.array(nonEmptyString).min(1),
    createdAt: timestamp,
    status: z.enum(["pending", "confirmed"]),
    resumeTarget: nonEmptyString,
    confirmedAt: timestamp.optional(),
    confirmedBy: nonEmptyString.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status === "pending" && (record.confirmedAt || record.confirmedBy)) {
      context.addIssue({
        code: "custom",
        path: [record.confirmedAt ? "confirmedAt" : "confirmedBy"],
        message: "Pending checkpoints cannot contain confirmation metadata",
      });
    }
    if (record.status === "confirmed" && (!record.confirmedAt || !record.confirmedBy)) {
      context.addIssue({
        code: "custom",
        path: [!record.confirmedAt ? "confirmedAt" : "confirmedBy"],
        message: "Confirmed checkpoints require confirmation time and actor",
      });
    }
  });

export const migrationRecordSchema = z
  .object({
    schemaVersion: version,
    fromVersion: z.number().int().nonnegative(),
    toVersion: version,
    migratedAt: timestamp,
    records: z.array(nonEmptyString),
  })
  .strict();

export const taskDagRecordSchema = z
  .object({
    schemaVersion: version,
    tasksDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: timestamp,
    nodes: z.array(
      z.object({
        id: nonEmptyString,
        dependsOn: z.array(nonEmptyString),
        checked: z.boolean(),
      }).strict(),
    ),
    topologicalOrder: z.array(nonEmptyString),
  })
  .strict();

const tddCommandEvidenceSchema = z.object({
  command: nonEmptyString,
  exitCode: z.number().int(),
  recordedAt: timestamp,
}).strict();

export const tddEvidenceRecordSchema = z.discriminatedUnion("disposition", [
  z.object({
    schemaVersion: version,
    runId: nonEmptyString,
    taskId: nonEmptyString,
    disposition: z.literal("required"),
    requirements: z.array(nonEmptyString).min(1),
    scenarios: z.array(nonEmptyString).min(1),
    red: tddCommandEvidenceSchema,
    green: tddCommandEvidenceSchema,
    refactor: z.array(tddCommandEvidenceSchema).min(1),
    createdAt: timestamp,
  }).strict(),
  z.object({
    schemaVersion: version,
    runId: nonEmptyString,
    taskId: nonEmptyString,
    disposition: z.literal("not_applicable"),
    requirements: z.array(nonEmptyString).min(1),
    scenarios: z.array(nonEmptyString).min(1),
    rationale: nonEmptyString,
    reviewedBy: nonEmptyString,
    reviewedAt: timestamp,
    createdAt: timestamp,
  }).strict(),
]);

export const persistenceRecordSchemas = {
  manifest: runManifestSchema,
  taskResult: taskResultSchema,
  review: reviewRecordSchema,
  validation: validationRecordSchema,
  checkpoint: checkpointRecordSchema,
  migration: migrationRecordSchema,
  taskDag: taskDagRecordSchema,
  tddEvidence: tddEvidenceRecordSchema,
} as const;

export type PersistenceRecordKind = keyof typeof persistenceRecordSchemas;

export function decodePersistedRecord<TKind extends PersistenceRecordKind>(
  kind: TKind,
  contents: string,
  path: string,
): z.output<(typeof persistenceRecordSchemas)[TKind]> {
  let payload: unknown;
  try {
    payload = JSON.parse(contents);
  } catch (cause) {
    throw new HarnessError(
      "PERSISTENCE_CORRUPT_RECORD",
      `Persisted ${kind} record is not valid JSON: ${path}`,
      { kind, path },
      { cause },
    );
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HarnessError(
      "PERSISTENCE_CORRUPT_RECORD",
      `Persisted ${kind} record must be an object: ${path}`,
      { kind, path, issues: [{ path: "<root>", message: "Expected object" }] },
    );
  }

  const schemaVersion = (payload as Record<string, unknown>).schemaVersion;
  if (!Number.isInteger(schemaVersion)) {
    throw new HarnessError(
      "PERSISTENCE_CORRUPT_RECORD",
      `Persisted ${kind} record has no valid schema version: ${path}`,
      { kind, path, issues: [{ path: "schemaVersion", message: "Expected integer" }] },
    );
  }
  if (schemaVersion !== 1) {
    throw new HarnessError(
      "PERSISTENCE_UNSUPPORTED_VERSION",
      `Unsupported ${kind} schema version ${schemaVersion}: ${path}`,
      { kind, path, schemaVersion, supportedVersions: [1] },
    );
  }

  const result = persistenceRecordSchemas[kind].safeParse(payload);
  if (result.success) {
    return result.data as z.output<(typeof persistenceRecordSchemas)[TKind]>;
  }

  const issues = result.error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.map(String).join(".") || "<root>",
  }));
  throw new HarnessError(
    "PERSISTENCE_CORRUPT_RECORD",
    `Persisted ${kind} record is incompatible at ${issues[0]?.path ?? "<root>"}: ${path}`,
    { kind, path, issues },
  );
}

export type RunManifest = z.infer<typeof runManifestSchema>;
export type ManualActionCategory = z.infer<typeof manualActionCategorySchema>;
export type TaskResultRecord = z.infer<typeof taskResultSchema>;
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export type ValidationRecord = z.infer<typeof validationRecordSchema>;
export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;
export type MigrationRecord = z.infer<typeof migrationRecordSchema>;
export type TaskDagRecord = z.infer<typeof taskDagRecordSchema>;
export type TddEvidenceRecord = z.infer<typeof tddEvidenceRecordSchema>;