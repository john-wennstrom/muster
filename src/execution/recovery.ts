import { z } from "zod";
import { truncateBytes } from "../context/candidates.ts";
import { redactString } from "../judgment/egress.ts";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { changeRunId } from "../persistence/change-usage-store.ts";

/** What a failed attempt leaves for the next one: bounded, redacted, and only the latest two kept. */
export const FAILURE_EVIDENCE_MAX_BYTES = 2_000;
export const FAILURE_OUTPUT_TAIL_MAX_BYTES = 1_000;
export const FAILURES_KEPT = 2;

const attemptSchema = z.object({
  attempt: z.number().int().positive(),
  /** How the attempt ended: the pipeline's outcome, or `error` for an attempt that threw. */
  outcome: z.string().min(1),
  evidence: z.array(z.string()),
  /** The failing verification command, when a verification failure caused the failure. */
  reproduction: z.object({
    command: z.string().min(1),
    exitCode: z.number().int().nullable(),
    outputTail: z.string(),
  }).strict().nullable(),
  /** What the builder said it changed, when it said. */
  statedFix: z.string().optional(),
  changedPaths: z.array(z.string()),
  recordedAt: z.string(),
}).strict();

export const failureRecordSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  failures: z.array(attemptSchema).min(1).max(FAILURES_KEPT),
}).strict();

export type FailureAttempt = z.infer<typeof attemptSchema>;
export type FailureRecord = z.infer<typeof failureRecordSchema>;

export interface FailureInput {
  readonly attempt: number;
  readonly outcome: string;
  readonly evidence: readonly string[];
  readonly reproduction: { readonly command: string; readonly exitCode: number | null; readonly output: string } | null;
  readonly statedFix?: string;
  readonly changedPaths: readonly string[];
  readonly recordedAt: string;
}

export const failurePath = (taskId: string): string => `failures/${taskId}.json`;

/** The last `limit` UTF-8 bytes of `text`, never splitting a character. */
function tailBytes(text: string, limit: number): string {
  const characters = [...text];
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const size = Buffer.byteLength(characters[start - 1]!, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    start -= 1;
  }
  return characters.slice(start).join("");
}

/** Redaction first, then the bound, so a secret cut in half by the bound is never left half-visible. */
const bounded = (text: string, limit: number): string => truncateBytes(redactString(text), limit);

function attemptRecord(input: FailureInput): FailureAttempt {
  return attemptSchema.parse({
    attempt: input.attempt,
    outcome: input.outcome,
    evidence: input.evidence.map((item) => bounded(item, FAILURE_EVIDENCE_MAX_BYTES)),
    reproduction: input.reproduction
      ? {
        command: bounded(input.reproduction.command, FAILURE_OUTPUT_TAIL_MAX_BYTES),
        exitCode: input.reproduction.exitCode,
        outputTail: tailBytes(redactString(input.reproduction.output), FAILURE_OUTPUT_TAIL_MAX_BYTES),
      }
      : null,
    ...(input.statedFix?.trim() ? { statedFix: bounded(input.statedFix, FAILURE_EVIDENCE_MAX_BYTES) } : {}),
    changedPaths: [...input.changedPaths],
    recordedAt: input.recordedAt,
  });
}

/** Every failure record of the task, oldest first; empty when there is none or the file is unreadable. */
async function readFailures(store: AtomicJsonStore, changeName: string, taskId: string): Promise<FailureAttempt[]> {
  try {
    return failureRecordSchema.parse(await store.read(changeRunId(changeName), failurePath(taskId))).failures;
  } catch {
    return [];
  }
}

/** Records one failed attempt for the task, keeping the two latest. */
export async function recordFailure(
  store: AtomicJsonStore,
  changeName: string,
  taskId: string,
  failure: FailureInput,
): Promise<FailureAttempt> {
  const record = attemptRecord(failure);
  const failures = [...await readFailures(store, changeName, taskId), record].slice(-FAILURES_KEPT);
  await store.write(changeRunId(changeName), failurePath(taskId), failureRecordSchema.parse({ schemaVersion: 1, taskId, failures }));
  return record;
}

/** The task's most recent failed attempt, if any, so the next attempt starts informed. */
export async function latestFailure(store: AtomicJsonStore, changeName: string, taskId: string): Promise<FailureAttempt | null> {
  return (await readFailures(store, changeName, taskId)).at(-1) ?? null;
}

/** The failure as the builder prompt's optional block, or an empty string when there is none. */
export function failureBlock(failure: FailureAttempt | null): string {
  if (!failure) return "";
  const lines = [
    `Prior failure (attempt ${failure.attempt}, ${failure.outcome}):`,
    ...failure.evidence.map((item) => `- ${item}`),
  ];
  if (failure.reproduction) {
    lines.push(
      `Reproduce with: ${failure.reproduction.command} (exit ${failure.reproduction.exitCode ?? "none"})`,
      "Output tail:",
      failure.reproduction.outputTail,
    );
  }
  if (failure.statedFix) lines.push(`The previous attempt said it changed: ${failure.statedFix}`);
  if (failure.changedPaths.length > 0) lines.push(`Paths changed by the previous attempt: ${failure.changedPaths.join(", ")}`);
  lines.push("Address this failure; do not repeat the same approach.");
  return lines.join("\n");
}
