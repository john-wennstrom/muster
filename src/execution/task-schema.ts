import { posix } from "node:path";
import { z } from "zod";
import type {
  ParsedTask,
  ParsedTaskDocument,
  ParsedTaskPhase,
} from "./task-parser.ts";
import { HarnessError } from "../shared/errors.ts";
import { manualActionCategorySchema } from "../persistence/records.ts";

const nonEmptyLine = z.string().min(1).refine((value) => !/[\r\n]/.test(value));
const taskId = z.string().regex(/^[0-9]+(?:\.[0-9A-Za-z_-]+)+$/);
const manualSchema = z
  .object({
    category: manualActionCategorySchema,
    condition: nonEmptyLine.optional(),
    reason: nonEmptyLine,
    instructions: z.array(nonEmptyLine).min(1),
    expectedOutcome: nonEmptyLine,
    resumeTarget: taskId,
  })
  .strict();

const taskMetadataSchema = z
  .object({
    id: taskId,
    dependsOn: z.array(taskId),
    role: z.enum(["architect", "builder", "reviewer", "validator", "manual"]),
    reads: z.array(nonEmptyLine),
    writes: z.array(nonEmptyLine),
    requirements: z.array(nonEmptyLine).min(1),
    scenarios: z.array(nonEmptyLine).min(1),
    verify: z.array(nonEmptyLine).min(1),
    manual: manualSchema.nullable(),
  })
  .strict();

export type TaskMetadata = z.infer<typeof taskMetadataSchema>;

export interface ValidatedTask extends Omit<ParsedTask, "metadata">, TaskMetadata {}

export interface ValidatedTaskPhase extends Omit<ParsedTaskPhase, "tasks"> {
  tasks: ValidatedTask[];
}

export interface ValidatedTaskDocument {
  phases: ValidatedTaskPhase[];
  tasks: ValidatedTask[];
}

export interface TaskReferenceIndex {
  requirements: ReadonlySet<string>;
  scenarios: ReadonlySet<string>;
}

function invalidMetadata(
  task: ParsedTask,
  field: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new HarnessError(
    "TASK_METADATA_INVALID",
    `Task ${task.checkboxId} metadata ${field}: ${message} at ${task.location.path}:${task.location.metadata.start.line}:${task.location.metadata.start.column}`,
    {
      taskId: task.checkboxId,
      field,
      location: task.location.metadata,
      ...details,
    },
  );
}

function normalizeScope(scope: string, task: ParsedTask, field: string): string {
  const portable = scope.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:\//.test(portable) ||
    portable.includes("\0")
  ) {
    return invalidMetadata(task, field, "scope must be repository-relative", { scope });
  }
  const normalized = posix.normalize(portable);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return invalidMetadata(task, field, "scope escapes the repository root", { scope });
  }
  return normalized;
}

function uniqueValues(
  values: readonly string[],
  task: ParsedTask,
  field: string,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (seen.has(value)) {
      invalidMetadata(task, `${field}.${index}`, `duplicate value ${JSON.stringify(value)}`);
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function validateTask(task: ParsedTask, references: TaskReferenceIndex): ValidatedTask {
  const result = taskMetadataSchema.safeParse(task.metadata);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    return invalidMetadata(
      task,
      issue.path.map(String).join(".") || "<root>",
      issue.message,
      { issues: result.error.issues },
    );
  }
  const metadata = result.data;
  if (metadata.id !== task.checkboxId) {
    return invalidMetadata(task, "id", "must match the checkbox identifier", {
      checkboxId: task.checkboxId,
      metadataId: metadata.id,
    });
  }
  if (metadata.role === "manual" && metadata.manual === null) {
    return invalidMetadata(task, "manual", "is required when role is manual");
  }

  const reads = uniqueValues(
    metadata.reads.map((scope, index) => normalizeScope(scope, task, `reads.${index}`)),
    task,
    "reads",
  );
  const writes = uniqueValues(
    metadata.writes.map((scope, index) => normalizeScope(scope, task, `writes.${index}`)),
    task,
    "writes",
  );
  const dependencies = uniqueValues(metadata.dependsOn, task, "dependsOn");

  for (let index = 0; index < metadata.requirements.length; index++) {
    const reference = metadata.requirements[index]!;
    if (!references.requirements.has(reference)) {
      return invalidMetadata(task, `requirements.${index}`, "references an unknown requirement", {
        reference,
      });
    }
  }
  for (let index = 0; index < metadata.scenarios.length; index++) {
    const reference = metadata.scenarios[index]!;
    if (!references.scenarios.has(reference)) {
      return invalidMetadata(task, `scenarios.${index}`, "references an unknown scenario", {
        reference,
      });
    }
  }

  return {
    ...task,
    ...metadata,
    dependsOn: dependencies,
    reads,
    writes,
  };
}

export function validateTaskDocument(
  document: ParsedTaskDocument,
  references: TaskReferenceIndex,
): ValidatedTaskDocument {
  const seenIds = new Set<string>();
  const tasks = document.tasks.map((task) => {
    if (seenIds.has(task.checkboxId)) {
      return invalidMetadata(task, "id", "duplicates another task identifier");
    }
    seenIds.add(task.checkboxId);
    return validateTask(task, references);
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const phases = document.phases.map((phase) => ({
    ...phase,
    tasks: phase.tasks.map((task) => byId.get(task.checkboxId)!),
  }));
  return { phases, tasks };
}