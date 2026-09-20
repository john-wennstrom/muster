import { randomUUID } from "node:crypto";
import type { TaskMetadata } from "../execution/task-schema.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import {
  checkpointRecordSchema,
  type CheckpointRecord,
  type ManualActionCategory,
} from "../persistence/records.ts";
import type { JudgmentRuntime } from "../judgment/ask.ts";
import { classifyCommand } from "../tools/command-approval.ts";
import {
  classifyProhibitedCommand,
  type StructuredCommandRequest,
} from "../tools/host-runner.ts";
import { HarnessError } from "../shared/errors.ts";

type PlannedManualAction = NonNullable<TaskMetadata["manual"]>;

export interface ManualCheckpointContext {
  store: AtomicJsonStore;
  runId: string;
  changeName: string;
  taskId: string;
  branch: readonly string[];
}

export interface CreateManualCheckpointInput extends ManualCheckpointContext {
  category: ManualActionCategory;
  reason: string;
  instructions: readonly string[];
  resumeTarget: string;
  secretValues?: readonly string[];
}

export interface PlannedManualCheckpointInput extends ManualCheckpointContext {
  manual: PlannedManualAction;
  secretValues?: readonly string[];
}

export interface RuntimeManualActionInput extends ManualCheckpointContext {
  request: StructuredCommandRequest;
  secretValues?: readonly string[];
  /**
   * Adds the categories judgment finds to those the rules find. Absent or disabled, the guard
   * is the rules alone. The change and task are the ones this input already names.
   */
  judgment?: {
    runtime: JudgmentRuntime;
    /** The worktree the request's working directory is made relative to before it is sent. */
    worktreePath: string;
    deadlineMs?: number;
  };
}

export interface ConfirmManualCheckpointInput {
  store: AtomicJsonStore;
  runId: string;
  changeName: string;
  checkpointId: string;
  confirmedBy: string;
  now?: () => Date;
}

export type RuntimeManualActionResult<T> =
  | { status: "executed"; value: T }
  | { status: "awaiting_user"; checkpoint: CheckpointRecord };

const runtimeGuidance: Readonly<Record<ManualActionCategory, {
  reason: string;
  instructions: readonly string[];
}>> = {
  authentication: {
    reason: "Authentication must be completed by the user",
    instructions: [
      "Complete authentication directly in a trusted terminal without sending credentials through the agent channel",
    ],
  },
  elevated_permission: {
    reason: "Elevated permissions require direct user approval",
    instructions: [
      "Review and perform the privileged step directly in a trusted terminal",
    ],
  },
  destructive: {
    reason: "A destructive operation requires direct user approval",
    instructions: [
      "Review the destructive operation and perform it manually only if it is intended",
    ],
  },
  external_side_effect: {
    reason: "An external side effect requires direct user approval",
    instructions: [
      "Review and perform the external action manually, then verify its non-secret outcome",
    ],
  },
  design_decision: {
    reason: "A material design decision requires an approved answer",
    instructions: [
      "Record the chosen design in the approved planning artifacts before resuming",
    ],
  },
};

function redactSecretPatterns(value: string): string {
  return value
    .replace(
      /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:--?)(?:password|passphrase|token|api[-_]?key|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:password|passphrase|token|api[-_]?key|secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    );
}

export function redactManualText(
  value: string,
  secretValues: readonly string[] = [],
): string {
  let sanitized = value.replaceAll("\0", "");
  for (const secret of secretValues) {
    if (secret) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return redactSecretPatterns(sanitized).trim();
}

function sanitizedText(
  value: string,
  fallback: string,
  secretValues: readonly string[],
): string {
  return redactManualText(value, secretValues) || fallback;
}

export async function createManualCheckpoint(
  input: CreateManualCheckpointInput,
): Promise<CheckpointRecord> {
  const id = `checkpoint-${randomUUID()}`;
  const secretValues = input.secretValues ?? [];
  const fallbackReason = `Manual ${input.category.replaceAll("_", " ")} action is required`;
  const checkpoint = checkpointRecordSchema.parse({
    schemaVersion: 1,
    id,
    runId: input.runId,
    changeName: input.changeName,
    taskId: input.taskId,
    branch: [...input.branch],
    category: input.category,
    reason: sanitizedText(input.reason, fallbackReason, secretValues),
    instructions: input.instructions.map((instruction) =>
      sanitizedText(instruction, "Complete the manual action outside the agent channel", secretValues)
    ),
    createdAt: new Date().toISOString(),
    status: "pending",
    resumeTarget: input.resumeTarget,
  });
  await input.store.write(input.runId, `checkpoints/${id}.json`, checkpoint);
  return checkpoint;
}

export async function loadManualCheckpoint(
  store: AtomicJsonStore,
  runId: string,
  checkpointId: string,
): Promise<CheckpointRecord> {
  const record = await store.read(runId, `checkpoints/${checkpointId}.json`);
  const result = checkpointRecordSchema.safeParse(record);
  if (!result.success) {
    throw new HarnessError(
      "MANUAL_CHECKPOINT_INVALID",
      `Manual checkpoint ${checkpointId} is invalid`,
      { checkpointId, runId, issues: result.error.issues },
    );
  }
  if (result.data.id !== checkpointId || result.data.runId !== runId) {
    throw new HarnessError(
      "MANUAL_CHECKPOINT_MISMATCH",
      `Manual checkpoint ${checkpointId} does not belong to run ${runId}`,
      {
        checkpointId,
        runId,
        recordId: result.data.id,
        recordRunId: result.data.runId,
      },
    );
  }
  return result.data;
}

export async function confirmManualCheckpoint(
  input: ConfirmManualCheckpointInput,
): Promise<CheckpointRecord> {
  const checkpoint = await loadManualCheckpoint(input.store, input.runId, input.checkpointId);
  if (checkpoint.changeName !== input.changeName) {
    throw new HarnessError(
      "MANUAL_CHECKPOINT_MISMATCH",
      `Manual checkpoint ${checkpoint.id} belongs to change ${checkpoint.changeName}`,
      {
        checkpointId: checkpoint.id,
        expectedChange: input.changeName,
        actualChange: checkpoint.changeName,
      },
    );
  }
  if (checkpoint.status !== "pending") {
    throw new HarnessError(
      "MANUAL_CHECKPOINT_CONFIRMED",
      `Manual checkpoint ${checkpoint.id} is already confirmed`,
      { checkpointId: checkpoint.id, confirmedAt: checkpoint.confirmedAt },
    );
  }
  const confirmedBy = input.confirmedBy.trim();
  if (!confirmedBy) {
    throw new HarnessError(
      "MANUAL_RESUME_INVALID",
      "Manual checkpoint confirmation requires an actor",
      { checkpointId: checkpoint.id },
    );
  }
  const confirmed = checkpointRecordSchema.parse({
    ...checkpoint,
    status: "confirmed",
    confirmedAt: (input.now ?? (() => new Date()))().toISOString(),
    confirmedBy,
  });
  await input.store.write(input.runId, `checkpoints/${checkpoint.id}.json`, confirmed);
  return confirmed;
}

export function classifyPlannedManualAction(
  task: Pick<TaskMetadata, "manual">,
): PlannedManualAction | null {
  return task.manual ? { ...task.manual, instructions: [...task.manual.instructions] } : null;
}

export async function checkpointPlannedManualAction(
  input: PlannedManualCheckpointInput,
): Promise<CheckpointRecord> {
  return createManualCheckpoint({
    store: input.store,
    runId: input.runId,
    changeName: input.changeName,
    taskId: input.taskId,
    branch: input.branch,
    category: input.manual.category,
    reason: input.manual.reason,
    instructions: input.manual.instructions,
    resumeTarget: input.manual.resumeTarget,
    secretValues: input.secretValues,
  });
}

export function classifyRuntimeManualAction(
  request: StructuredCommandRequest,
): ManualActionCategory | null {
  return classifyProhibitedCommand(request);
}

export async function guardRuntimeManualAction<T>(
  input: RuntimeManualActionInput,
  execute: () => Promise<T>,
): Promise<RuntimeManualActionResult<T>> {
  const category = input.judgment
    ? (await classifyCommand(input.request, {
      worktreePath: input.judgment.worktreePath,
      judgment: {
        runtime: input.judgment.runtime,
        changeName: input.changeName,
        taskId: input.taskId,
        deadlineMs: input.judgment.deadlineMs,
      },
    })).category
    : classifyRuntimeManualAction(input.request);
  if (!category) return { status: "executed", value: await execute() };

  const guidance = runtimeGuidance[category];
  const checkpoint = await createManualCheckpoint({
    store: input.store,
    runId: input.runId,
    changeName: input.changeName,
    taskId: input.taskId,
    branch: input.branch,
    category,
    reason: guidance.reason,
    instructions: guidance.instructions,
    resumeTarget: input.taskId,
    secretValues: input.secretValues,
  });
  return { status: "awaiting_user", checkpoint };
}