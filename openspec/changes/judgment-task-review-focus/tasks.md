## 1. Reviewer Prompt

- [ ] 1.1 Add an optional focus list to the task code-review dispatcher's options in `src/review/code-review.ts` and render a focus block before the closing instruction that tells the reviewer to disregard it wherever the diff does not support it; verify with tests that a non-empty list adds the block and changes nothing else, that an empty or absent list yields a prompt identical to the current one, and that the existing dispatcher tests still pass unchanged.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/review/code-review.ts", "tests/review/code-review.test.ts"]
  writes: ["src/review/code-review.ts", "tests/review/code-review.test.ts"]
  requirements: ["judgment-task-review-focus: The reviewer receives an advisory focus list", "judgment-task-review-focus: No signal leaves the prompt unchanged"]
  scenarios: ["Focus block is added", "Focus is advisory", "No signal gives today's prompt"]
  verify: ["bun test tests/review/code-review.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Decision

- [ ] 2.1 Register the `review.task_focus` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts`: yes/no questions on scope containment, contract match, scenario coverage, test-first consistency, stubs or hard-coded values, and security-boundary changes, a four-level rubric on impact outside the diff, a declared effect of adding advice, and a gate mapping each answer past its threshold to one fixed catalogue phrase, capped at four in the fixed priority order; verify with tests that every phrase is reachable, that uncertain answers yield no item, that five or more triggered answers yield exactly four in priority order, and that no item contains model-written text.

  ```yaml harness-task
  id: "2.1"
  dependsOn: []
  role: builder
  reads: ["src/judgment/**", "src/review/code-review.ts"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "tests/judgment/task-review-focus.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-task-review-focus: Focus items are fixed phrases"]
  scenarios: ["Items come from the catalogue", "Items are capped and ordered"]
  verify: ["bun test tests/judgment/task-review-focus.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Review Step Integration

- [ ] 3.1 Wire the review step in `src/change/phases/task-steps/review.ts`: add the optional judgment runtime to the task step context in `src/change/phases/task-steps/context.ts` if it is absent, build the state from the contract, a diff excerpt of at most 24,000 bytes cut at a file boundary with the complete changed-path list declared for the denylist, the test evidence, the scopes, and the test-first evidence, call the decision before the reviewer, pass the focus items only in enforce mode, and after the review reconcile the record with finding counts, areas raised, and which focus items named a raised area; verify with tests that enforce adds the block, that shadow and every unavailable reason leave the prompt unchanged, that disabled judgment sends nothing, that a denied changed path leaves the prompt unchanged, that the reviewer still runs when judgment answers that every check passes, and that approval follows the reviewer's verdict in both directions.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.1", "2.1"]
  role: builder
  reads: ["src/change/phases/task-steps/**", "src/review/code-review.ts", "src/judgment/**", "src/execution/change-digests.ts"]
  writes: ["src/change/phases/task-steps/review.ts", "src/change/phases/task-steps/context.ts", "tests/muster/task-review-step.test.ts"]
  requirements: ["judgment-task-review-focus: Unavailable judgment yields today's review", "judgment-task-review-focus: Shadow mode leaves the prompt unchanged and records the focus", "judgment-task-review-focus: Records are reconciled with the review's findings", "judgment-task-review-focus: The review state is bounded", "judgment-task-review-focus: Judgment never changes a review gate"]
  scenarios: ["Every unavailable reason yields today's prompt", "Disabled judgment adds no work", "Shadow prompt is unchanged", "Review outcome is recorded", "Oversized diff is excerpted with the full file list", "Every task is still reviewed", "Task outcome depends only on the reviewer"]
  verify: ["bun test tests/muster/task-review-step.test.ts", "bun test tests/review/code-review.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Add the comparison report in `src/judgment/task-review-report.ts` that reads this decision's records and reports, for reviews that received a focus list and reviews that did not, the review count, the mean required-finding and recommendation counts, and the share of focus items that named an area the reviewer raised; verify with tests over hand-built records covering both groups, an empty group, and unreconciled records excluded.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/judgment/audit.ts", "src/change/phases/task-steps/review.ts"]
  writes: ["src/judgment/task-review-report.ts", "tests/judgment/task-review-report.test.ts"]
  requirements: ["judgment-task-review-focus: Records are reconciled with the review's findings"]
  scenarios: ["Report compares focused and unfocused reviews"]
  verify: ["bun test tests/judgment/task-review-report.test.ts", "bun run typecheck"]
  manual: null
  ```

## 4. Documentation and Verification

- [ ] 4.1 Add the task review focus row to the per-call-site table in `docs/security.md`, naming the task contract, the diff excerpt with the changed paths, the test output, the authorized scopes, and the test-first evidence, and noting that test output is the field most likely to carry incidental secrets; verify the documentation checks pass.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.1"]
  role: builder
  reads: ["docs/security.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md"]
  requirements: ["judgment-task-review-focus: Review focus egress is documented"]
  scenarios: ["Security documentation lists the review focus egress"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [ ] 4.2 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that the reviewer prompt is identical to today's with judgment disabled and that no review gate changed.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["3.2", "4.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-task-review-focus: Unavailable judgment yields today's review", "judgment-task-review-focus: Judgment never changes a review gate"]
  scenarios: ["Disabled judgment adds no work", "Every task is still reviewed"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
