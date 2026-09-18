## 1. Implementation Step Extraction

- [ ] 1.1 Extract the builder agent-invocation step from its nested closure into a top-level function whose parameters are exactly the values it previously captured, moving its result schema with it; add focused tests covering its success, failure, and cancellation results with the child-process boundary substituted.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/change/**", "src/runtime/**", "src/execution/**", "src/agents/**", "tests/execution/**"]
  writes: ["src/change/phases/**", "tests/execution/builder-step.test.ts"]
  requirements: ["command-module-decomposition: Independently addressable agent-invocation steps"]
  scenarios: ["A single step is exercised", "A step's inputs are inspected"]
  verify: ["bun test tests/execution/builder-step.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 1.2 Extract the verification agent-invocation step the same way, taking its task, worktree, and cancellation explicitly; add focused tests covering a passing command sequence, a failing command, and cancellation.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/change/**", "src/execution/**", "src/tools/**", "tests/execution/**"]
  writes: ["src/change/phases/**", "tests/execution/verification-step.test.ts"]
  requirements: ["command-module-decomposition: Independently addressable agent-invocation steps"]
  scenarios: ["A single step is exercised", "A step is substituted"]
  verify: ["bun test tests/execution/verification-step.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 1.3 Extract the review agent-invocation step the same way, taking the builder and verification results explicitly instead of reading them from the enclosing scope; add focused tests covering an approving review, a revising review, and cancellation.

  ```yaml harness-task
  id: "1.3"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/change/**", "src/review/**", "src/execution/**", "tests/execution/**", "tests/review/**"]
  writes: ["src/change/phases/**", "tests/execution/review-step.test.ts"]
  requirements: ["command-module-decomposition: Independently addressable agent-invocation steps"]
  scenarios: ["A single step is exercised", "A step is substituted", "A step's inputs are inspected"]
  verify: ["bun test tests/execution/review-step.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 1.4 Reduce the orchestration module to run-level concerns only, invoking the three extracted steps through the existing substitution points; verify the full implementation run produces the same persisted records and reported result as before.

  ```yaml harness-task
  id: "1.4"
  dependsOn: ["1.3"]
  role: builder
  reads: ["src/change/**", "src/execution/**", "src/persistence/**", "tests/**"]
  writes: ["src/change/phases/**"]
  requirements: ["command-module-decomposition: Decomposition preserves behavior"]
  scenarios: ["Run is executed after decomposition"]
  verify: ["bun test tests/execution tests/e2e", "bun run typecheck"]
  manual: null
  ```

## 2. Layer Ownership

- [ ] 2.1 Move the verification command parser to the execution layer, the persisted record reader to the persistence layer, and the validated-task to collaboration-task adapter beside the collaboration type it produces; update every consumer and verify no module outside the orchestration imports the orchestration module to reach one of these behaviors.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.4"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/execution/**", "src/persistence/**", "src/change/**", "tests/**"]
  requirements: ["command-module-decomposition: Concerns are owned by their layer"]
  scenarios: ["A second consumer needs an embedded concern", "Orchestration module is read"]
  verify: ["bun test tests/execution tests/persistence", "bun run typecheck"]
  manual: null
  ```

## 3. Dispatch Decomposition

- [ ] 3.1 Split command-line parsing and handler dispatch into separate modules, keeping the existing exported entry points available by re-export; verify existing dispatcher tests pass without modification to their assertions.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/change/**", "tests/commands/**", "tests/muster/**"]
  writes: ["src/change/**"]
  requirements: ["command-module-decomposition: Single-responsibility dispatch modules", "command-module-decomposition: Decomposition preserves behavior"]
  scenarios: ["Public surface is consumed", "Command is invoked after decomposition"]
  verify: ["bun test tests/commands tests/muster", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Split outcome rendering and failure classification into separate modules, moving the lifecycle-blocker construction with rendering while leaving the lifecycle decision with the existing action resolver; verify a change to classification requires no edit to parsing, dispatch, rendering, or registration.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/change/**", "src/controller/action-resolver.ts", "src/shared/errors.ts", "tests/**"]
  writes: ["src/change/**"]
  requirements: ["command-module-decomposition: Single-responsibility dispatch modules"]
  scenarios: ["Failure classification is changed", "Rendering is changed"]
  verify: ["bun test tests/muster tests/commands", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.3 Split host registration into its own module and confirm the dispatch surface's exported entry points are unchanged for every consumer; verify the extension install smoke test passes unmodified.

  ```yaml harness-task
  id: "3.3"
  dependsOn: ["3.2"]
  role: builder
  reads: ["src/change/**", "src/muster/index.ts", "tests/extension/**", "tests/e2e/**"]
  writes: ["src/change/**"]
  requirements: ["command-module-decomposition: Single-responsibility dispatch modules", "command-module-decomposition: Decomposition preserves behavior"]
  scenarios: ["Public surface is consumed", "Command is invoked after decomposition"]
  verify: ["bun run test:extension-smoke", "bun test tests/e2e", "bun run typecheck"]
  manual: null
  ```

## 4. Verification

- [ ] 4.1 Run the full cross-platform validation set and compare pass/fail counts against the recorded pre-existing platform baseline, confirming the decomposition changed no behavior.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.3"]
  role: validator
  reads: ["src/**", "tests/**", "docs/testing.md"]
  writes: []
  requirements: ["command-module-decomposition: Decomposition preserves behavior"]
  scenarios: ["Run is executed after decomposition", "Command is invoked after decomposition"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run test:extension-smoke", "bun run ci:validate", "bun run docs:check"]
  manual: null
  ```

- [ ] 4.2 Smoke-test a full implementation run live against real child-process spawns, confirming the extracted builder, verification, and review steps behave identically end to end.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1"]
  role: manual
  reads: ["src/**", "docs/**"]
  writes: []
  requirements: ["command-module-decomposition: Decomposition preserves behavior", "command-module-decomposition: Independently addressable agent-invocation steps"]
  scenarios: ["Run is executed after decomposition", "A single step is exercised"]
  verify: ["bun run typecheck"]
  manual:
    category: external_side_effect
    reason: "The automated suite never spawns a real child process, so the extracted agent-invocation steps cannot be observed end to end from it."
    instructions:
      - "Run an implementation phase interactively against a scratch change with at least two dependent tasks."
      - "Confirm the builder, verification, and review steps each run and report as they did before the split."
      - "Confirm persisted run records, task results, reviews, and the run manifest match the pre-split shapes."
    expectedOutcome: "A full implementation run completes with the same reported result and the same persisted records as before the decomposition."
    resumeTarget: "4.2"
  ```
