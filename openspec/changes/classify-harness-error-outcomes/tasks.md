## 1. Declared Codes

- [ ] 1.1 Declare a planning-agent failure code and a reserved unrecognized-failure code, and determine whether any production path raises a model-availability condition; declare that code only if a raising path exists. Verify typechecking succeeds and record the decision for the model-availability case.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/shared/errors.ts", "src/runtime/**", "src/muster/**", "src/agents/model-router.ts"]
  writes: ["src/shared/errors.ts"]
  requirements: ["command-failure-classification: Unrecognized failures are declared", "command-failure-classification: Phase-specific failure attribution"]
  scenarios: ["Reported code is consumed", "Planning agent fails"]
  verify: ["bun run typecheck"]
  manual: null
  ```

## 2. Exhaustive Classification

- [ ] 2.1 Replace the inline error-code sets and nested blocker selection with one total classification declaration keyed by the declared code union, and remove any classification for a code that remains undeclared; verify typechecking fails when a code is added without a classification and when a classification names an unknown code.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/shared/errors.ts", "src/runtime/**", "tests/commands/**", "tests/muster/**"]
  writes: ["src/shared/errors.ts", "src/runtime/**"]
  requirements: ["command-failure-classification: Exhaustive error classification"]
  scenarios: ["New error code is declared", "Classification names a code that does not exist", "Classification set is audited"]
  verify: ["bun run typecheck", "bun test tests/commands tests/muster"]
  manual: null
  ```

- [ ] 2.2 Classify the declared codes that are thrown in production but currently reach the dispatcher unclassified, reviewing each resulting change from plain failure to blocked outcome deliberately; verify the resulting blocker category, artifact, and next step for each newly classified code.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "tests/commands/**", "tests/muster/**"]
  writes: ["src/runtime/**", "tests/muster/command-outcomes.test.ts"]
  requirements: ["command-failure-classification: Classified failures carry actionable detail"]
  scenarios: ["Blocking failure is raised", "Failure identifies an artifact", "Failure carries checkpoint identifiers"]
  verify: ["bun test tests/muster/command-outcomes.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.3 Use the reserved unrecognized-failure code for errors that carry no declared code, and confirm cancellation continues to report a cancelled outcome for both host abort and the declared cancellation code; verify by tests covering an undeclared dependency error, a host abort, and a raised cancellation.

  ```yaml harness-task
  id: "2.3"
  dependsOn: ["2.2"]
  role: builder
  reads: ["src/shared/errors.ts", "src/runtime/**", "tests/muster/**"]
  writes: ["src/runtime/**", "tests/muster/command-outcomes.test.ts"]
  requirements: ["command-failure-classification: Unrecognized failures are declared", "command-failure-classification: Cancellation is distinguished from failure"]
  scenarios: ["Dependency throws an undeclared error", "Host cancels an invocation", "Cancellation is raised as an error"]
  verify: ["bun test tests/muster/command-outcomes.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Phase Attribution

- [ ] 3.1 Raise the planning-agent failure code from the planning phase instead of the exploration code, raise the model-availability code from model resolution if it was declared, and search the repository for remaining uses of the exploration code outside exploration; verify planning agent failures report and persist under the planning code.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.3"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/runtime/**", "src/muster/**", "tests/muster/**"]
  requirements: ["command-failure-classification: Phase-specific failure attribution"]
  scenarios: ["Planning agent fails", "Failure code is used for attribution"]
  verify: ["bun test tests/muster tests/commands", "bun run typecheck"]
  manual: null
  ```

## 4. Verification

- [ ] 4.1 Add a test that drives each declared error code through the dispatcher's conversion and asserts the resulting status and blocker category match the declaration; verify it covers every declared code and fails when a classification and its conversion disagree.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/shared/errors.ts", "src/runtime/**", "tests/muster/**"]
  writes: ["tests/muster/failure-classification.test.ts"]
  requirements: ["command-failure-classification: Exhaustive error classification", "command-failure-classification: Classified failures carry actionable detail"]
  scenarios: ["Classification set is audited", "Blocking failure is raised"]
  verify: ["bun test tests/muster/failure-classification.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.2 Run the full cross-platform validation set and compare pass/fail counts against the recorded pre-existing platform baseline, confirming no unintended status changes were introduced.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/testing.md"]
  writes: []
  requirements: ["command-failure-classification: Exhaustive error classification", "command-failure-classification: Cancellation is distinguished from failure"]
  scenarios: ["Classification set is audited", "Host cancels an invocation"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
