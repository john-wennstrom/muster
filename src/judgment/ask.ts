import type { AtomicJsonStore } from "../persistence/atomic-json-store.ts";
import type { UsagePhase, UsageRecord } from "../telemetry/usage.ts";
import {
  JUDGMENT_MODEL,
  createFetchJudgmentClient,
  type JsonValue,
  type JudgmentAnswers,
  type JudgmentClient,
  type JudgmentQuestions,
  type JudgmentUnavailableReason,
} from "./client.ts";
import { prepareEgress } from "./egress.ts";
import {
  createDecisionRecord,
  digestState,
  writeDecisionRecord,
  type NewDecisionRecord,
} from "./audit.ts";
import type { Decision, GateOutcome } from "./gates.ts";
import {
  resolveJudgmentPolicy,
  type JudgmentEnvironment,
  type JudgmentMode,
} from "./policy.ts";
import { JudgmentFixtureMissingError } from "./replay.ts";
import { validateQuestions } from "./questions.ts";
import {
  createJudgmentUsage,
  emitJudgmentUsage,
  forecastJudgment,
  judgmentCostUsd,
  type JudgmentBudget,
} from "./usage.ts";

/**
 * The two entry points. `askJev` is the transport call: typed answers or an unavailable
 * result, never an exception for an operational failure. `judge` wraps it for a decision:
 * it asks, applies the decision's gate, records the outcome, and returns a verdict whose
 * shape carries the mode, so a call site cannot act in shadow mode even by mistake.
 */

export interface AskRequest {
  readonly decision: { readonly id: string; readonly version: number; readonly enabledBy?: string };
  readonly changeName: string;
  readonly phase: UsagePhase;
  readonly taskId?: string;
  readonly state: JsonValue;
  readonly questions: JudgmentQuestions;
  /** Every repository path whose content contributes to the state, checked against the denylist. */
  readonly sourcePaths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export type AskResult =
  | {
      readonly available: true;
      readonly mode: JudgmentMode;
      readonly answers: JudgmentAnswers;
      readonly reportedModel: string;
      readonly inputTokens: number;
      readonly usage: UsageRecord;
      readonly stateDigest: string;
    }
  | {
      readonly available: false;
      readonly reason: JudgmentUnavailableReason;
      readonly detail?: string;
      /** Null when the mode could not be resolved. */
      readonly mode: JudgmentMode | null;
      readonly reportedModel?: string;
      readonly stateDigest: string | null;
    };

export interface JudgeRequest<Input> {
  readonly input: Input;
  readonly changeName: string;
  readonly phase: UsagePhase;
  readonly taskId?: string;
  readonly state: JsonValue;
  readonly sourcePaths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  /** The activity acting avoids, from the budget estimate of the skipped stage. */
  readonly avoided?: NonNullable<NewDecisionRecord["avoided"]>;
}

export type JudgmentVerdict<Value> =
  /** Unavailable: do what you do today. */
  | { readonly kind: "fallback"; readonly reason: JudgmentUnavailableReason; readonly recordId: string | null }
  /** Evaluated and recorded, nothing to act on: do what you do today. */
  | { readonly kind: "shadow"; readonly recordId: string | null }
  /** The gate's outcome: act with a value, or abstain (and do what you do today). */
  | { readonly kind: "enforce"; readonly outcome: GateOutcome<Value>; readonly recordId: string | null };

export interface JudgmentRuntime {
  readonly enabled: boolean;
  askJev(request: AskRequest): Promise<AskResult>;
  judge<Input, Value>(
    decision: Decision<Input, Value>,
    request: JudgeRequest<Input>,
  ): Promise<JudgmentVerdict<Value>>;
}

export interface JudgmentRuntimeOptions {
  readonly env: JudgmentEnvironment;
  readonly store: AtomicJsonStore;
  readonly budget?: JudgmentBudget;
  /** Replaces the live client, as tests do with a replaying or dead client. */
  readonly client?: JudgmentClient;
  readonly fetch?: typeof fetch;
  /** Told about a persistence failure, which never reaches the caller. */
  readonly onError?: (error: unknown) => void;
}

/** With judgment disabled or unconfigured: no network, no records, no accounting. */
export function createInertJudgmentRuntime(
  reason: Extract<JudgmentUnavailableReason, "disabled" | "not_configured"> = "disabled",
): JudgmentRuntime {
  return {
    enabled: false,
    async askJev() {
      return { available: false, reason, mode: null, stateDigest: null };
    },
    async judge() {
      return { kind: "fallback", reason, recordId: null };
    },
  };
}

/** Reasons that mean judgment was never in play, and so leave no record. */
function leavesNoRecord(reason: JudgmentUnavailableReason): boolean {
  return reason === "disabled" || reason === "not_configured";
}

export function createJudgmentRuntime(options: JudgmentRuntimeOptions): JudgmentRuntime {
  const global = resolveJudgmentPolicy(options.env);
  if (!global.enabled && leavesNoRecord(global.reason)) {
    return createInertJudgmentRuntime(global.reason as "disabled" | "not_configured");
  }
  const onError = options.onError ?? (() => {});

  const guarded = async (work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };

  async function askJev(request: AskRequest): Promise<AskResult> {
    const policy = resolveJudgmentPolicy(options.env, { decisionFlag: request.decision.enabledBy });
    if (!policy.enabled) {
      return {
        available: false,
        reason: policy.reason,
        detail: policy.detail,
        mode: null,
        stateDigest: null,
      };
    }
    const { mode, apiKey } = policy;

    const egress = prepareEgress({
      state: request.state,
      questions: request.questions,
      sourcePaths: request.sourcePaths,
      secretValues: [apiKey],
    });
    if (!egress.ok) {
      return { available: false, reason: egress.reason, detail: egress.detail, mode, stateDigest: null };
    }
    const stateDigest = digestState(egress.stateText);

    const forecast = forecastJudgment(options.budget, {
      phase: request.phase,
      taskId: request.taskId,
      estimatedTokens: egress.estimatedTokens,
    });
    if (!forecast.allowed) {
      return {
        available: false,
        reason: "budget",
        detail: forecast.decision?.reason,
        mode,
        stateDigest,
      };
    }

    const client = options.client ?? createFetchJudgmentClient({ apiKey, fetch: options.fetch });
    let result;
    try {
      result = await client.request({
        state: egress.state,
        questions: request.questions,
        decision: { id: request.decision.id, version: request.decision.version },
        signal: request.signal,
        deadlineMs: request.deadlineMs,
      });
    } catch (error) {
      // A missing recording is a test failure, not an outage: converting it would let the
      // fallback run and the test pass while testing nothing.
      if (error instanceof JudgmentFixtureMissingError) throw error;
      return {
        available: false,
        reason: "network",
        detail: error instanceof Error ? error.message : "client failed",
        mode,
        stateDigest,
      };
    }
    if (!result.available) {
      return {
        available: false,
        reason: result.reason,
        detail: result.detail,
        mode,
        reportedModel: result.reportedModel,
        stateDigest,
      };
    }

    const usage = createJudgmentUsage({
      changeName: request.changeName,
      phase: request.phase,
      taskId: request.taskId,
      inputTokens: result.inputTokens,
      durationMs: result.durationMs,
    });
    await guarded(() => emitJudgmentUsage(options.store, request.changeName, options.budget, usage));
    return {
      available: true,
      mode,
      answers: result.answers,
      reportedModel: result.model,
      inputTokens: result.inputTokens,
      usage,
      stateDigest,
    };
  }

  async function judge<Input, Value>(
    decision: Decision<Input, Value>,
    request: JudgeRequest<Input>,
  ): Promise<JudgmentVerdict<Value>> {
    // Decide availability before building anything, so a disabled decision does no work.
    const policy = resolveJudgmentPolicy(options.env, { decisionFlag: decision.enabledBy });
    if (!policy.enabled && leavesNoRecord(policy.reason)) {
      return { kind: "fallback", reason: policy.reason, recordId: null };
    }

    const questions = validateQuestions(decision.id, decision.questions(request.input));
    const asked = await askJev({
      decision: { id: decision.id, version: decision.version, enabledBy: decision.enabledBy },
      changeName: request.changeName,
      phase: request.phase,
      taskId: request.taskId,
      state: request.state,
      questions,
      sourcePaths: request.sourcePaths,
      signal: request.signal,
      deadlineMs: request.deadlineMs,
    });

    const base = {
      decision: decision.id,
      decisionVersion: decision.version,
      phase: request.phase,
      taskId: request.taskId,
      mode: asked.mode,
      requestedModel: JUDGMENT_MODEL,
      stateDigest: asked.stateDigest,
      avoided: request.avoided,
    } as const;

    if (!asked.available) {
      if (leavesNoRecord(asked.reason)) return { kind: "fallback", reason: asked.reason, recordId: null };
      const recordId = await persist({
        ...base,
        status: "unavailable",
        unavailableReason: asked.reason,
        reportedModel: asked.reportedModel ?? null,
        answers: null,
        gate: null,
        wouldHaveActed: false,
        acted: false,
        spend: null,
      });
      return { kind: "fallback", reason: asked.reason, recordId };
    }

    let outcome: GateOutcome<Value>;
    try {
      outcome = decision.gate(asked.answers);
    } catch (error) {
      onError(error);
      outcome = { act: false, reason: "gate failed" };
    }
    const acted = asked.mode === "enforce" && outcome.act;
    const recordId = await persist({
      ...base,
      status: "answered",
      unavailableReason: null,
      reportedModel: asked.reportedModel,
      answers: asked.answers as NonNullable<NewDecisionRecord["answers"]>,
      gate: (outcome.act
        ? { act: true, value: outcome.value }
        : { act: false, reason: outcome.reason }) as NewDecisionRecord["gate"],
      wouldHaveActed: outcome.act,
      acted,
      spend: {
        inputTokens: asked.usage.inputTokens,
        outputTokens: 0,
        costUsd: judgmentCostUsd(asked.usage.inputTokens),
      },
    });

    // In shadow mode the outcome is recorded but not returned, so it cannot be acted on.
    return asked.mode === "shadow"
      ? { kind: "shadow", recordId }
      : { kind: "enforce", outcome, recordId };

    async function persist(record: NewDecisionRecord): Promise<string | null> {
      const created = createDecisionRecord(request.changeName, record);
      const written = await guarded(() => writeDecisionRecord(options.store, request.changeName, created));
      return written ? created.recordId : null;
    }
  }

  return { enabled: true, askJev, judge };
}
