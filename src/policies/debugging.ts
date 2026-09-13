import { z } from "zod";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { HarnessError } from "../shared/errors.ts";

const nonEmptyString = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });

const failureSchema = z.object({
  attempt: z.number().int().positive(),
  reproduction: nonEmptyString,
  evidence: z.array(nonEmptyString).min(1),
  recordedAt: timestamp,
}).strict();

const investigationSchema = z.object({
  rootCauseHypothesis: nonEmptyString,
  discriminatingCheck: nonEmptyString,
  minimalFix: nonEmptyString,
  regressionVerification: nonEmptyString,
  regressionExitCode: z.number().int(),
  recordedAt: timestamp,
}).strict();

export const debuggingStateSchema = z.object({
  schemaVersion: z.literal(1),
  runId: nonEmptyString,
  taskId: nonEmptyString,
  threshold: z.number().int().positive(),
  mode: z.enum(["ordinary_repair", "systematic_debugging"]),
  failures: z.array(failureSchema),
  investigation: investigationSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((state, context) => {
  const expectedMode = state.failures.length >= state.threshold
    ? "systematic_debugging"
    : "ordinary_repair";
  if (state.mode !== expectedMode) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: `Expected ${expectedMode} for ${state.failures.length} failure(s)`,
    });
  }
  if (state.mode === "ordinary_repair" && state.investigation) {
    context.addIssue({
      code: "custom",
      path: ["investigation"],
      message: "Investigation cannot begin before the configured threshold",
    });
  }
  state.failures.forEach((failure, index) => {
    if (failure.attempt !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["failures", index, "attempt"],
        message: "Failure attempts must be sequential",
      });
    }
  });
});

export type DebuggingState = z.infer<typeof debuggingStateSchema>;
export type UnexpectedFailure = Omit<DebuggingState["failures"][number], "attempt">;
export type DebuggingInvestigation = NonNullable<DebuggingState["investigation"]>;

function invalid(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new HarnessError("DEBUGGING_STATE_INVALID", message, details);
}

export function createDebuggingState(input: {
  runId: string;
  taskId: string;
  threshold: number;
  createdAt: string;
}): DebuggingState {
  return debuggingStateSchema.parse({
    schemaVersion: 1,
    ...input,
    mode: "ordinary_repair",
    failures: [],
    updatedAt: input.createdAt,
  });
}

export function recordUnexpectedFailure(
  state: DebuggingState,
  failure: UnexpectedFailure,
): DebuggingState {
  const current = debuggingStateSchema.parse(state);
  if (current.mode === "systematic_debugging") {
    return invalid("Ordinary repair is disabled after the debugging threshold", {
      taskId: current.taskId,
      threshold: current.threshold,
    });
  }
  const failures = [
    ...current.failures,
    { ...failure, attempt: current.failures.length + 1 },
  ];
  return debuggingStateSchema.parse({
    ...current,
    failures,
    mode: failures.length >= current.threshold ? "systematic_debugging" : "ordinary_repair",
    updatedAt: failure.recordedAt,
  });
}

export function beginDebugging(
  state: DebuggingState,
  investigation: DebuggingInvestigation,
): DebuggingState {
  const current = debuggingStateSchema.parse(state);
  if (current.mode !== "systematic_debugging") {
    return invalid("Systematic debugging cannot begin before the configured threshold", {
      taskId: current.taskId,
      failures: current.failures.length,
      threshold: current.threshold,
    });
  }
  return debuggingStateSchema.parse({
    ...current,
    investigation,
    updatedAt: investigation.recordedAt,
  });
}

export async function persistDebuggingState(
  store: AtomicJsonStore,
  state: DebuggingState,
): Promise<void> {
  const validated = debuggingStateSchema.parse(state);
  await store.write(validated.runId, `debugging/${validated.taskId}.json`, validated);
}