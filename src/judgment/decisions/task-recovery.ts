import type { JsonValue } from "../client.ts";
import { act, abstain, defineDecision, choiceOf } from "../decision.ts";
import { TASK_RECOVERY_ACTIONS, TASK_RECOVERY_QUESTION_IDS } from "../questions.ts";
import { loadQuestions } from "../../prompts/questions.ts";

/**
 * task.recovery: what to do after a task attempt failed. Only a confident, recognized choice
 * acts; anything else abstains into what happens without judgment (a blocked outcome is final
 * for the run). Retry is the only answer that adds an attempt, and the caller bounds it by the
 * scheduler's limit, so the decision never lengthens a loop beyond what the scheduler allowed.
 * The band is a starting point; the answers recorded in shadow mode are what tune it.
 */
export const TASK_RECOVERY_CONFIDENCE_AT_LEAST = 0.7;

export type TaskRecoveryAction = (typeof TASK_RECOVERY_ACTIONS)[number];

export interface TaskRecoveryInput {
  /** The task's definition: what it was asked to do. */
  readonly taskDefinition: string;
  readonly lane: string;
  readonly failure: {
    readonly attempt: number;
    readonly outcome: string;
    readonly evidence: readonly string[];
    readonly reproduction: { readonly command: string; readonly exitCode: number | null; readonly outputTail: string } | null;
    readonly statedFix?: string;
  };
}

/** The state sent for the call: the task, its lane, and the failure text, and never source. */
export function taskRecoveryState(input: TaskRecoveryInput): JsonValue {
  return {
    task: input.taskDefinition,
    lane: input.lane,
    failure: {
      attempt: input.failure.attempt,
      outcome: input.failure.outcome,
      evidence: [...input.failure.evidence],
      reproduction: input.failure.reproduction ? { ...input.failure.reproduction } : null,
      ...(input.failure.statedFix ? { statedFix: input.failure.statedFix } : {}),
    },
  };
}

export interface TaskRecoveryGateValue {
  readonly action: TaskRecoveryAction;
  readonly confidence: number;
}

export const taskRecoveryDecision = defineDecision<TaskRecoveryInput, TaskRecoveryGateValue>({
  id: "task.recovery",
  version: 1,
  // Escalating and stopping add caution; retry adds an attempt the caller bounds by the scheduler's limit.
  effects: ["adds_caution"],
  representativeInput: {
    taskDefinition: "Retry `parseInvoice` once when invoice_total is missing",
    lane: "medium",
    failure: {
      attempt: 1,
      outcome: "blocked",
      evidence: ["bun test tests/billing/invoice.test.ts: exit 1"],
      reproduction: { command: "bun test tests/billing/invoice.test.ts", exitCode: 1, outputTail: "Expected 1 retry, received 0" },
      statedFix: "Moved the retry above the total check",
    },
  },
  questions: () => loadQuestions("task.recovery"),
  state: taskRecoveryState,
  gate: (answers) => {
    const choice = choiceOf(answers, TASK_RECOVERY_QUESTION_IDS.nextStep);
    if (!choice) return abstain("no next step was judged");
    if (!(TASK_RECOVERY_ACTIONS as readonly string[]).includes(choice.choice)) {
      return abstain(`unrecognized next step ${choice.choice}`);
    }
    if (!(choice.confidence >= TASK_RECOVERY_CONFIDENCE_AT_LEAST)) {
      return abstain(`next step ${choice.choice} judged with low confidence (${choice.confidence})`);
    }
    return act({ action: choice.choice as TaskRecoveryAction, confidence: choice.confidence });
  },
});
