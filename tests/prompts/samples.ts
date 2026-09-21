import type { ExploreAgentRequest } from "../../src/controller/explore.ts";
import { reviewPrompt } from "../../src/controller/review.ts";
import { taskScopeNotice } from "../../src/agents/spawn.ts";
import { renderExplorePrompt } from "../../src/change/phases/exploration.ts";
import { builderPrompt } from "../../src/change/phases/task-steps/builder.ts";
import { taskReviewerPrompt } from "../../src/change/phases/task-steps/review.ts";
import { judgmentCatalog } from "../../src/judgment/catalog.ts";
import { type AnyDecision } from "../../src/judgment/decision.ts";
import { canonicalize, validateQuestions } from "../../src/judgment/questions.ts";
import { planningReviewCorrection, planningReviewerPrompt } from "../../src/review/planning-reviewer.ts";
import { renderTaskCodeReviewPrompt } from "../../src/review/code-review.ts";
import { renderDebatePrompt, renderOpinionPrompt, renderPlanPrompt, renderRequiredChanges } from "../../src/planning/prompts.ts";

/**
 * Sample inputs for every prompt an agent is sent. The capture script writes what these render to
 * tests/prompts/golden, and the golden test renders them again and compares byte for byte.
 *
 * Every place src/ passes text to an agent: renderExplorePrompt (explore), renderPlanPrompt,
 * renderOpinionPrompt and renderDebatePrompt (planning), reviewPrompt and
 * planningReviewerPrompt / planningReviewCorrection (planning review), builderPrompt (builder),
 * renderTaskCodeReviewPrompt and taskReviewerPrompt (task review), and taskScopeNotice, which the
 * spawn entry point appends to every prompt. The pipeline's fresh-session prompt in
 * src/execution/task-runner.ts is not sent to an agent; the builder step builds its own.
 */

const planningInput = {
  changeName: "add-search",
  request: "Add a search box to the toolbar that filters the visible items.",
  lane: "small" as const,
  authoritativeContext: { changeRoot: "/repo/openspec/changes/add-search" },
};

const exploreRequest = (overrides: Partial<ExploreAgentRequest>): ExploreAgentRequest => ({
  phase: "explore",
  access: "read",
  prompt: "How does the retry policy decide when to stop?",
  authoritativeContext: {},
  supplementalFacts: [],
  ...overrides,
});

const task = {
  id: "1.2",
  description: "Add the search filter to the toolbar",
  requirements: ["search: The toolbar filters items"],
  scenarios: ["Typing filters the list"],
  verify: ["bun test tests/search.test.ts"],
  reads: ["src/**"],
  writes: ["src/toolbar.ts"],
} as never;

const reviewOptions = {
  runId: "run-1",
  taskId: "1.2",
  contract: { definition: "Add the search filter", requirements: ["search: The toolbar filters items"], scenarios: ["Typing filters the list"] },
  diff: { digest: "abc123", summary: "diff --git a/src/toolbar.ts b/src/toolbar.ts\n+filter()" },
  tests: ["bun test tests/search.test.ts: passed"],
  scopes: { reads: ["src/**"], writes: ["src/toolbar.ts"], violations: [] },
  tddEvidence: { red: "failed", green: "passed" },
} as never;

export function renderAgentPrompts(): Record<string, string> {
  return {
    "explore-bare": renderExplorePrompt(exploreRequest({})),
    "explore-full": renderExplorePrompt(exploreRequest({
      authoritativeContext: { changeName: "add-retry", phase: "explore" },
      supplementalFacts: [{ source: "serena", fact: "RetryPolicy is defined in src/retry.ts" }] as never,
    })),
    "planning-review-request": reviewPrompt(["proposal.md", "design.md", "specs/search/spec.md", "tasks.md"], "sha256:abc"),
    "planning-review-request-notes": reviewPrompt(
      ["proposal.md", "tasks.md"],
      "sha256:abc",
      "Pay attention to the task ordering.",
      ["Task 1.1 has no verify command", "Requirement search is not covered"],
    ),
    "planning-reviewer": planningReviewerPrompt("Perform an independent planning review."),
    "planning-reviewer-correction": planningReviewerPrompt(
      "Perform an independent planning review.",
      planningReviewCorrection("it was not valid JSON (Unexpected token)"),
    ),
    "planning-plan-small": renderPlanPrompt(planningInput),
    "planning-plan-large-refine-retry": renderPlanPrompt({
      ...planningInput,
      lane: "large",
      triageProceeds: true,
      currentArtifacts: [{ path: "proposal.md", content: "# Proposal\n\nAdd a search box." }, { path: "tasks.md", content: "## 1. Toolbar\n" }],
      requiredChanges: renderRequiredChanges({ round: 1, requiredChanges: ["Add a scenario for empty input"], criticalFindings: ["Task 1.1 has no verify command"] }),
      priorAnalysis: [{ model: "openai/gpt-test", content: "Prefer a debounce." }, { model: "anthropic/claude-test", content: "Filter on input." }],
      validationFailures: '- tasks[0].verify[0]: Executable "cargo" is not allowed by profile verification',
    }),
    "planning-opinion": renderOpinionPrompt(planningInput),
    "planning-debate": renderDebatePrompt({ ...planningInput, lane: "large", priorAnalysis: [{ model: "openai/gpt-test", content: "Prefer a debounce." }] }),
    "planning-required-changes": renderRequiredChanges({ round: 2, requiredChanges: ["Handle the empty-query case"], criticalFindings: [] }),
    builder: builderPrompt(task),
    "builder-retry": builderPrompt(task, {
      attempt: 1,
      outcome: "blocked",
      evidence: ["bun test tests/toolbar.test.ts: exit 1"],
      reproduction: { command: "bun test tests/toolbar.test.ts", exitCode: 1, outputTail: "Expected 1 result, received 0" },
      statedFix: "Filtered on input",
      changedPaths: ["src/toolbar.ts"],
      recordedAt: "2026-09-21T10:00:00.000Z",
    }),
    "task-review": renderTaskCodeReviewPrompt(reviewOptions),
    "task-review-focus": renderTaskCodeReviewPrompt({ ...(reviewOptions as object), focus: ["Callers of Toolbar", "Empty input"] } as never),
    "task-reviewer": taskReviewerPrompt("Review task 1.2."),
    "scope-read": taskScopeNotice({ mode: "read", reads: ["**"], writes: [] }),
    "scope-write": taskScopeNotice({ mode: "write", reads: ["src/**"], writes: ["src/toolbar.ts"] }),
  };
}

const threeItems = <T>(make: (index: number) => T): T[] => [1, 2, 3].map(make);

/** The inputs a decision's questions depend on, when they depend on any. */
const REPEATED_INPUTS: Record<string, unknown> = {
  "change.triage": { candidates: threeItems((index) => ({ path: `src/file-${index}.ts` })) },
  "review.extraction": { candidates: threeItems((index) => ({ text: `line ${index}` })) },
  "plan.lint": { tasks: threeItems((index) => ({ id: `1.${index}` })) },
};

/** Canonical JSON of every decision's questions: representative input, plus three items where they repeat. */
export function renderQuestionGoldens(catalog: readonly AnyDecision[] = judgmentCatalog): Record<string, string> {
  const goldens: Record<string, string> = {};
  for (const decision of catalog) {
    goldens[decision.id] = canonicalize(validateQuestions(decision.id, decision.questions(decision.representativeInput)));
    const repeated = REPEATED_INPUTS[decision.id];
    if (repeated) {
      goldens[`${decision.id}.three`] = canonicalize(validateQuestions(decision.id, decision.questions(repeated)));
    }
  }
  return goldens;
}
