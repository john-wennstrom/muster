import type { JsonValue } from "../client.ts";
import { act, abstain, defineDecision, choiceOf } from "../decision.ts";
import { COMMAND_CATEGORIES, COMMAND_QUESTION_IDS } from "../questions.ts";
import { loadQuestions } from "../../prompts/questions.ts";

/**
 * command.classification: which manual-approval category, if any, a host command belongs to.
 * The category choice alone drives the gate: any category other than none acts, at any
 * confidence, because an uncertain classifier on a question about destructive or external
 * effects is itself a reason to involve a human. None abstains, and the caller then does what
 * it does without judgment. The three yes/no answers are recorded and never enter the
 * outcome; using them to add categories would raise sensitivity before any data exists. The
 * value's category vocabulary is defined here, not imported from the tools layer, and matches
 * the manual-action categories it is later handed to.
 */
export const COMMAND_UNCERTAIN_NONE_BELOW = 0.7;
export const COMMAND_UNCERTAIN_NONE_REASON = "none judged with low confidence";

export type JudgedCommandCategory = Exclude<(typeof COMMAND_CATEGORIES)[number], "none">;

export interface CommandClassificationInput {
  readonly executable: string;
  readonly args: readonly string[];
  /** The working directory relative to the worktree, "." at its root. */
  readonly cwd: string;
  readonly profile: string;
}

/** The state sent for the call: exactly the command's shape, and never the environment or a file. */
export function commandState(input: CommandClassificationInput): JsonValue {
  return {
    executable: input.executable,
    args: [...input.args],
    cwd: input.cwd,
    profile: input.profile,
  };
}

export interface CommandGateValue {
  readonly category: JudgedCommandCategory;
  readonly confidence: number;
}

export const commandClassificationDecision = defineDecision<CommandClassificationInput, CommandGateValue>({
  id: "command.classification",
  version: 1,
  // A judged category only adds a manual-approval requirement; none abstains into today's path.
  effects: ["adds_caution"],
  representativeInput: {
    executable: "npm",
    args: ["run", "deploy", "--", "--env", "production"],
    cwd: ".",
    profile: "verification",
  },
  questions: () => loadQuestions("command.classification"),
  state: commandState,
  gate: (answers) => {
    const category = choiceOf(answers, COMMAND_QUESTION_IDS.category);
    if (!category) return abstain("no category was judged");
    if (category.choice === "none") {
      return abstain(
        category.confidence < COMMAND_UNCERTAIN_NONE_BELOW
          ? `${COMMAND_UNCERTAIN_NONE_REASON} (${category.confidence})`
          : "none",
      );
    }
    if (!isJudgedCommandCategory(category.choice)) {
      return abstain(`unrecognized category ${category.choice}`);
    }
    return act({ category: category.choice, confidence: category.confidence });
  },
});

function isJudgedCommandCategory(choice: string): choice is JudgedCommandCategory {
  return choice !== "none" && (COMMAND_CATEGORIES as readonly string[]).includes(choice);
}

/** Whether a gate's abstention was a none the service was unsure of, for calibration. */
export function isUncertainNone(reason: string): boolean {
  return reason.startsWith(COMMAND_UNCERTAIN_NONE_REASON);
}
