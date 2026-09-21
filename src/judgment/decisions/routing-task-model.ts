import type { JsonValue } from "../client.ts";
import { act, abstain, defineDecision, noulOf, scoreOf } from "../decision.ts";
import { TASK_ROUTING_QUESTION_IDS, TASK_ROUTING_RISK_QUESTION_IDS } from "../questions.ts";
import { loadQuestions } from "../../prompts/questions.ts";

/**
 * routing.task_model: whether a task may run on the economy lanes, and how hard its builder and
 * reviewer should think. Acting can downgrade the model and the thinking, the changes in the
 * rollout that can lower output quality, so it acts only on a conjunction of guards: the task is confidently mechanical, each
 * of five risks is confidently absent, and its reach is confidently narrow. Every guard needs a
 * confident answer, so a missing, malformed, or uncertain one abstains into the primary builder.
 * These bounds are starting points; the outcomes recorded in shadow mode are what tune them.
 */
/** The mechanical probability must be strictly above this. */
export const TASK_ROUTING_MECHANICAL_ABOVE = 0.8;
/** Every risk probability must be strictly below this. */
export const TASK_ROUTING_RISK_BELOW = 0.3;
/** The reach score must be strictly below this: contained or neighbouring. */
export const TASK_ROUTING_REACH_BELOW = 1.5;
/** The reach answer must be at least this confident. */
export const TASK_ROUTING_REACH_CONFIDENCE = 0.8;
/** A reach score strictly below this is contained, so the task is narrow; up to the bound above is moderate. */
export const TASK_ROUTING_NARROW_BELOW = 0.5;

/** Thinking levels the gate can choose; the caller never raises a task above its configured level. */
export type RoutedBuilderThinking = "low" | "medium";
export type RoutedReviewerThinking = "medium" | "high";

export type TaskRoutingLane = "primary" | "economy";

/** A task's contract, as sent: no source and no file content. */
export interface TaskRoutingInput {
  readonly description: string;
  readonly requirements: readonly string[];
  readonly scenarios: readonly string[];
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly verify: readonly string[];
}

/** The state sent for the call: exactly the task's description, requirements, scenarios, scopes, and verification. */
export function taskRoutingState(input: TaskRoutingInput): JsonValue {
  return {
    description: input.description,
    requirements: [...input.requirements],
    scenarios: [...input.scenarios],
    reads: [...input.reads],
    writes: [...input.writes],
    verify: [...input.verify],
  };
}

export interface TaskRoutingGateValue {
  /** The lane the gate chose; the gate acts only to choose the economy lane. */
  readonly lane: "economy";
  readonly mechanical: number;
  /** Each risk question's probability, in question order. */
  readonly risks: Readonly<Record<string, number>>;
  readonly reach: number;
  readonly reachConfidence: number;
  /** Narrow, mechanical, risk-free work needs less thought than moderate-reach work; neither is below low. */
  readonly builderThinking: RoutedBuilderThinking;
  readonly reviewerThinking: RoutedReviewerThinking;
}

export const modelRoutingDecision = defineDecision<TaskRoutingInput, TaskRoutingGateValue>({
  id: "routing.task_model",
  version: 2,
  // Acting spends less on the same work; every abstention falls through to the primary builder.
  effects: ["reduces_work"],
  representativeInput: {
    description: "Rename the `--verbose` flag to `--debug` in the command parser and its help text",
    requirements: ["cli: The debug flag is accepted"],
    scenarios: ["Debug flag enables debug output"],
    reads: ["src/cli/**"],
    writes: ["src/cli/parser.ts", "tests/cli/parser.test.ts"],
    verify: ["bun test tests/cli/parser.test.ts"],
  },
  questions: () => loadQuestions("routing.task_model"),
  state: taskRoutingState,
  gate: (answers) => {
    const failed: string[] = [];
    const mechanical = noulOf(answers, TASK_ROUTING_QUESTION_IDS.mechanical);
    if (mechanical === null || !Number.isFinite(mechanical)) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.mechanical} was not answered`);
    } else if (!(mechanical > TASK_ROUTING_MECHANICAL_ABOVE)) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.mechanical} probability ${mechanical} is not above ${TASK_ROUTING_MECHANICAL_ABOVE}`);
    }
    const risks: Record<string, number> = {};
    for (const id of TASK_ROUTING_RISK_QUESTION_IDS) {
      const probability = noulOf(answers, id);
      if (probability === null || !Number.isFinite(probability)) {
        failed.push(`${id} was not answered`);
      } else if (!(probability < TASK_ROUTING_RISK_BELOW)) {
        failed.push(`${id} probability ${probability} is not below ${TASK_ROUTING_RISK_BELOW}`);
      } else {
        risks[id] = probability;
      }
    }
    const reach = scoreOf(answers, TASK_ROUTING_QUESTION_IDS.reach);
    if (!reach || !Number.isFinite(reach.score) || !Number.isFinite(reach.confidence)) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.reach} was not answered`);
    } else if (reach.confidence < TASK_ROUTING_REACH_CONFIDENCE) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.reach} confidence ${reach.confidence} is below ${TASK_ROUTING_REACH_CONFIDENCE}`);
    } else if (!(reach.score < TASK_ROUTING_REACH_BELOW)) {
      failed.push(`${TASK_ROUTING_QUESTION_IDS.reach} ${reach.score} is not below ${TASK_ROUTING_REACH_BELOW}`);
    }
    if (failed.length > 0 || mechanical === null || !reach) return abstain(failed.join("; "));
    return act({
      lane: "economy" as const,
      mechanical,
      risks,
      reach: reach.score,
      reachConfidence: reach.confidence,
      ...(reach.score < TASK_ROUTING_NARROW_BELOW
        ? { builderThinking: "low" as const, reviewerThinking: "medium" as const }
        : { builderThinking: "medium" as const, reviewerThinking: "high" as const }),
    });
  },
});
