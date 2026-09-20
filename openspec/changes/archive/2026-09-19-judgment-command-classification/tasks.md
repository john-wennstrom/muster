## 1. Classification

- [x] 1.1 Register the `command.classification` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts`: a category choice among none, authentication, elevated permission, destructive, and external side effect with each defined by reversibility and reach, yes/no questions on irreversibility, remote mutation, and credential use that are recorded but not gated, a declared effect of adding caution, and a gate that acts for any category other than none at any confidence; verify with tests that a low-confidence category still acts, that none abstains, that the yes/no answers never enter the outcome, and that the effect is declared.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/judgment/**", "src/tools/host-runner.ts"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "tests/judgment/command-classification.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-command-classification: An uncertain category still adds caution"]
  scenarios: ["Low-confidence category still denies"]
  verify: ["bun test tests/judgment/command-classification.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 1.2 Add the asynchronous classifier in `src/tools/command-approval.ts` that runs the unchanged rule classifier first and consults judgment only when the rules return nothing, skips the read-only profile and read-only version-control subcommands, builds the state from the executable, redacted arguments, working directory relative to the worktree, and profile, applies a deadline of at most 1.5 seconds, reuses successful classifications for identical commands through a bounded cache, and returns the category with its source and confidence; verify with tests, including a property test over every judgment answer, that a rule-denied command is never sent and never allowed, that none and unavailable results proceed, that an uncertain none is marked for calibration, that read-only commands are not sent, that a slow judgment yields to the deadline, that an identical command sends one request, that the state holds only the command shape with a credential flag redacted, and that disabled judgment does nothing.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/tools/**", "src/judgment/**", "tests/tools/**"]
  writes: ["src/tools/command-approval.ts", "tests/tools/command-approval.test.ts"]
  requirements: ["judgment-command-classification: The existing rules are a floor", "judgment-command-classification: None and unavailable proceed as today", "judgment-command-classification: Commands under read-only restrictions are not judged", "judgment-command-classification: Judgment latency is bounded", "judgment-command-classification: Only the command shape is sent"]
  scenarios: ["Rule-denied command is denied without judgment", "Judgment answering none cannot allow a rule-denied command", "Judged none proceeds", "Unavailable judgment proceeds", "Uncertain none is logged", "Disabled judgment adds no work", "Read-only git command is not judged", "Slow judgment does not delay a command beyond its deadline", "Identical command reuses the classification", "State holds only the command shape"]
  verify: ["bun test tests/tools/command-approval.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Enforcement Points

- [x] 2.1 Use the classifier in `runAuditedHostCommand` in `src/tools/host-runner.ts` through an optional judgment option, after profile validation and before the repository snapshot: in enforce mode deny a judged category with the prohibited-command error carrying the category, source, and confidence and emit the audit event identifying it as judged, and in shadow mode let the command proceed and record what would have been stopped; verify in the host-runner tests that a judged category denies a command the rules allow, that the denial and audit event name judgment, that shadow never blocks, and that every existing host-runner test passes unchanged.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/tools/**", "src/judgment/**", "tests/tools/**", "tests/security/**"]
  writes: ["src/tools/host-runner.ts", "tests/tools/host-runner.test.ts"]
  requirements: ["judgment-command-classification: Judgment can only add a manual category", "judgment-command-classification: Shadow mode records without blocking", "judgment-command-classification: Judged decisions are audited"]
  scenarios: ["Judged category denies a command the rules allow", "Judged category is tagged as judged", "Shadow judgment never blocks", "Denied command's audit event names judgment"]
  verify: ["bun test tests/tools/host-runner.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 2.2 Make the controller's runtime manual-action guard in `src/controller/manual-checkpoint.ts` accept the same classification through an optional judgment option, raising the same persisted checkpoint for a judged category as for a rule category; verify with tests that a judged authentication category persists a pending checkpoint of that category without executing the command, and that absent judgment the guard behaves as before.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/controller/manual-checkpoint.ts", "src/tools/command-approval.ts", "tests/controller/**"]
  writes: ["src/controller/manual-checkpoint.ts", "tests/controller/manual-checkpoint-judgment.test.ts"]
  requirements: ["judgment-command-classification: The checkpoint path receives the same classification"]
  scenarios: ["Judged category raises a checkpoint"]
  verify: ["bun test tests/controller/manual-checkpoint-judgment.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 2.3 Thread the optional judgment runtime from the implementation phase through the task step context, the builder step, and the legacy child adapter's broker options to the audited host command, adding the runtime to the task step context if it is absent; verify with adapter tests that a brokered child command judged as a manual category is denied end to end, that an adapter without a runtime behaves as before, and that disabled judgment sends nothing.

  ```yaml harness-task
  id: "2.3"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/agents/legacy-adapter.ts", "src/change/phases/**", "tests/agents/**"]
  writes: ["src/agents/legacy-adapter.ts", "src/change/phases/task-steps/builder.ts", "src/change/phases/task-steps/context.ts", "src/change/phases/implementation.ts", "tests/agents/legacy-adapter.test.ts"]
  requirements: ["judgment-command-classification: Judgment can only add a manual category", "judgment-command-classification: None and unavailable proceed as today"]
  scenarios: ["Judged category denies a command the rules allow", "Disabled judgment adds no work"]
  verify: ["bun test tests/agents/legacy-adapter.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Security Verification

- [x] 3.1 Add `tests/security/broker-host-judgment.test.ts` that re-runs the traversal, symlink escape, out-of-scope mutation, prohibited-command, and version-control denial scenarios of the existing adversarial suite under a judgment double that answers none for every command and another that answers a manual category for every command, plus a case whose arguments are written to steer the judgment toward none, leaving the existing adversarial test file unmodified; verify that the new file and the existing host-runner job pass and that no case is more permitted than without judgment.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.1", "2.2", "2.3"]
  role: builder
  reads: ["tests/security/broker-host-adversarial.test.ts", "src/tools/**", "src/judgment/**"]
  writes: ["tests/security/broker-host-judgment.test.ts"]
  requirements: ["judgment-command-classification: Security guarantees hold whatever judgment answers"]
  scenarios: ["Guarantees hold when judgment answers none for everything", "Guarantees hold when judgment answers a category for everything", "Manipulated argument content cannot relax anything"]
  verify: ["bun test tests/security", "bun run test:host-runner"]
  manual: null
  ```

## 4. Documentation and Verification

- [x] 4.1 Add the command classification row to the per-call-site table in `docs/security.md`, naming the executable, the redacted arguments, the relative working directory, and the profile, and update the description of the preflight checks to say that judged categories are added to the rule-produced ones and never replace them; verify the documentation checks pass with the required host-execution wording intact.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.1"]
  role: builder
  reads: ["docs/security.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md"]
  requirements: ["judgment-command-classification: Command egress is documented"]
  scenarios: ["Security documentation lists the command egress"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [x] 4.2 Run the full validation set, including the host-runner job, and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that rule-denied commands are unchanged and that no adversarial case became more permitted.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-command-classification: The existing rules are a floor", "judgment-command-classification: Security guarantees hold whatever judgment answers"]
  scenarios: ["Rule-denied command is denied without judgment", "Guarantees hold when judgment answers none for everything"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run test:host-runner", "bun run docs:check"]
  manual: null
  ```
