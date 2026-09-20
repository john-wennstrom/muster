import { z } from "zod";
import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import { HarnessError } from "../shared/errors.ts";

const nonEmptyString = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });

const failureSchema = z.object({
  attempt: z.number().int().positive(),
  reproduction: nonEmptyString,
  evidence: z.array(nonEmptyString).min(1),
  /** What the builder changed in the attempt that produced this failure. */
  attemptedFix: nonEmptyString.optional(),
  recordedAt: timestamp,
}).strict();

const probability = z.number().min(0).max(1);

/** One judged reading of the latest two failures, kept so consecutive rounds are computable from state. */
const assessmentSchema = z.object({
  /** The failure this assessment followed. */
  attempt: z.number().int().min(2),
  sameRootCause: probability,
  progress: probability,
  humanNeeded: probability,
  recordId: nonEmptyString.nullable(),
  recordedAt: timestamp,
}).strict();

/** A move to systematic debugging before the threshold, recorded explicitly so the threshold stays as configured. */
const escalationSchema = z.object({
  reason: nonEmptyString,
  attempt: z.number().int().positive(),
  recordId: nonEmptyString.nullable(),
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
  assessments: z.array(assessmentSchema).optional(),
  escalation: escalationSchema.optional(),
  investigation: investigationSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((state, context) => {
  const expectedMode = state.escalation || state.failures.length >= state.threshold
    ? "systematic_debugging"
    : "ordinary_repair";
  if (state.mode !== expectedMode) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: `Expected ${expectedMode} for ${state.failures.length} failure(s)`,
    });
  }
  if (state.escalation) {
    if (state.escalation.attempt >= state.threshold) {
      context.addIssue({
        code: "custom",
        path: ["escalation", "attempt"],
        message: "An early escalation must occur before the configured threshold",
      });
    }
    if (state.escalation.attempt !== state.failures.length) {
      context.addIssue({
        code: "custom",
        path: ["escalation", "attempt"],
        message: "An early escalation must occur at the latest recorded failure",
      });
    }
  }
  state.assessments?.forEach((assessment, index) => {
    const previous = state.assessments![index - 1];
    if (assessment.attempt > state.failures.length || (previous && assessment.attempt <= previous.attempt)) {
      context.addIssue({
        code: "custom",
        path: ["assessments", index, "attempt"],
        message: "Assessments must follow recorded failures in increasing order",
      });
    }
  });
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
export type FailureAssessment = z.infer<typeof assessmentSchema>;
export type DebuggingEscalation = z.infer<typeof escalationSchema>;
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