import {
  confirmManualCheckpoint,
  type ConfirmManualCheckpointInput,
} from "../controller/manual-checkpoint.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import type { CheckpointRecord } from "../persistence/records.ts";
import { HarnessError } from "../shared/errors.ts";

export interface ManualCheckpointUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ManualResumeCommandInput {
  args: string;
  runId: string;
  confirmedBy: string;
  store: AtomicJsonStore;
  ui: ManualCheckpointUi;
  now?: ConfirmManualCheckpointInput["now"];
}

export function renderManualCheckpointStatus(checkpoint: CheckpointRecord): string {
  const category = checkpoint.category.replaceAll("_", " ");
  const lines = [
    `Checkpoint: ${checkpoint.id}`,
    `Change: ${checkpoint.changeName}`,
    `Task: ${checkpoint.taskId}`,
    `Category: ${category}`,
    `Status: ${checkpoint.status}`,
    `Reason: ${checkpoint.reason}`,
  ];
  if (checkpoint.status === "pending") {
    lines.push(`Resume: /change resume ${checkpoint.changeName} ${checkpoint.id}`);
  } else {
    lines.push(`Confirmed by ${checkpoint.confirmedBy} at ${checkpoint.confirmedAt}`);
  }
  return lines.join("\n");
}

export function renderManualCheckpointNotification(
  checkpoint: CheckpointRecord,
  restored = false,
): string {
  return [
    `ACTION REQUIRED${restored ? " (restored)" : ""}`,
    `Change: ${checkpoint.changeName}`,
    `Task: ${checkpoint.taskId}`,
    `Reason: ${checkpoint.reason}`,
    "Instructions:",
    ...checkpoint.instructions.map((instruction) => `- ${instruction}`),
    `Resume: /change resume ${checkpoint.changeName} ${checkpoint.id}`,
  ].join("\n");
}

export function notifyManualCheckpoint(
  ui: ManualCheckpointUi,
  checkpoint: CheckpointRecord,
  restored = false,
): void {
  ui.notify(renderManualCheckpointNotification(checkpoint, restored), "warning");
}

export function restoreManualCheckpointNotifications(input: {
  ui: ManualCheckpointUi;
  checkpoints: readonly CheckpointRecord[];
}): string[] {
  const restored: string[] = [];
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status !== "pending") continue;
    notifyManualCheckpoint(input.ui, checkpoint, true);
    restored.push(checkpoint.id);
  }
  return restored;
}

export async function handleManualResumeCommand(
  input: ManualResumeCommandInput,
): Promise<CheckpointRecord> {
  const parts = input.args.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "resume") {
    throw new HarnessError(
      "MANUAL_RESUME_INVALID",
      "Usage: /change resume <change> <checkpoint-id>",
      { args: input.args },
    );
  }
  const [, changeName, checkpointId] = parts as [string, string, string];
  const checkpoint = await confirmManualCheckpoint({
    store: input.store,
    runId: input.runId,
    changeName,
    checkpointId,
    confirmedBy: input.confirmedBy,
    now: input.now,
  });
  input.ui.notify(
    `Manual checkpoint ${checkpoint.id} confirmed; resume target ${checkpoint.resumeTarget} is eligible for normal scheduling.`,
    "info",
  );
  return checkpoint;
}