## 1. Shared Helper Extraction

- [ ] 1.1 Extract command-line flag reading, path existence probing, and path containment checking into single shared owners; delete the duplicate copies in the explore handler, planning runner, command module, snapshot module, and verify handler, and verify the full suite still matches the recorded baseline.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/muster/**", "src/runtime/**", "src/shared/**", "tests/**"]
  writes: ["src/shared/**", "src/muster/**", "src/runtime/**"]
  requirements: ["change-command-runtime: Single ownership of shared runtime helpers"]
  scenarios: ["Shared behavior is needed by a second module", "Shared behavior changes"]
  verify: ["bun run typecheck", "bun run ci:test"]
  manual: null
  ```

- [ ] 1.2 Extract persisted record reading and change run-store opening (store, run identity, manifest read/write) into single owners under the persistence layer; replace the duplicate record readers and repeated store/run-identity/manifest expressions in the implementation runner, verify handler, finish handler, and snapshot module, and verify persistence tests still pass.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/persistence/**", "src/runtime/**", "src/muster/**", "tests/persistence/**"]
  writes: ["src/persistence/**", "src/runtime/**", "src/muster/**"]
  requirements: ["change-command-runtime: Single ownership of shared runtime helpers"]
  scenarios: ["Shared behavior is needed by a second module", "Shared behavior changes"]
  verify: ["bun test tests/persistence", "bun run typecheck"]
  manual: null
  ```

- [ ] 1.3 Extract validated task-document loading and source-digest reading into single owners under the execution layer; replace the duplicated task-loading blocks in the implementation runner and verify handler and the repeated head/diff/digest expressions, and verify execution tests still pass.

  ```yaml harness-task
  id: "1.3"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/execution/**", "src/runtime/**", "src/muster/**", "tests/execution/**"]
  writes: ["src/execution/**", "src/runtime/**", "src/muster/**"]
  requirements: ["change-command-runtime: Single ownership of shared runtime helpers"]
  scenarios: ["Shared behavior is needed by a second module", "Shared behavior changes"]
  verify: ["bun test tests/execution", "bun run typecheck", "bun run ci:test"]
  manual: null
  ```

## 2. Transcript Presentation Identity

- [ ] 2.1 Add the branding module exporting the custom message type, widget-key derivation, and outcome-derived details type; replace the private dispatcher literal and the hand-built widget-key prefix in agent progress, and add a test asserting the widget key and message type share one source.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.3"]
  role: builder
  reads: ["src/runtime/**", "extensions/fusion-harness/modules/runtime.ts", "tests/muster/**"]
  writes: ["src/runtime/**", "tests/muster/agent-progress.test.ts"]
  requirements: ["change-command-runtime: Single transcript presentation identity"]
  scenarios: ["Progress widget is displayed"]
  verify: ["bun test tests/muster/agent-progress.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Widen the transcript-posting seam to accept an outcome in addition to a string, attach the structured details payload, register a message renderer for the custom type, and verify by test that rendered content is unchanged for hosts without a renderer while details are present for hosts with one.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/runtime/**", "src/muster/**", "tests/commands/**", "tests/muster/**", "tests/e2e/**"]
  writes: ["src/runtime/**", "src/muster/**", "tests/commands/change-command.test.ts", "tests/muster/command-outcomes.test.ts"]
  requirements: ["change-command-runtime: Single transcript presentation identity"]
  scenarios: ["Interactive host renders a phase result", "Host has no renderer registered"]
  verify: ["bun test tests/commands tests/muster", "bun run typecheck"]
  manual: null
  ```

## 3. Declared Command Metadata

- [ ] 3.1 Add the per-action metadata table declaring argument shape, change requirement, lifecycle gating, and run-identity kind, typed so an action missing a declaration fails typechecking; verify the table covers every advertised action.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.2"]
  role: builder
  reads: ["src/runtime/**", "src/controller/action-resolver.ts", "tests/commands/**"]
  writes: ["src/runtime/**", "tests/commands/change-command.test.ts"]
  requirements: ["change-command-runtime: Declared per-action command metadata"]
  scenarios: ["New action is added"]
  verify: ["bun test tests/commands/change-command.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Derive argument parsing, usage strings, the advertised subcommand list, active-change persistence, and run-identity selection from the metadata table; remove the inline per-action special cases in the dispatcher and the hardcoded stateful-action list in the dependency assembly, and verify free-text parsing and arity rejection behave per the table.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/runtime/**", "src/muster/**", "tests/commands/**", "tests/e2e/**"]
  writes: ["src/runtime/**", "tests/commands/change-command.test.ts"]
  requirements: ["change-command-runtime: Declared per-action command metadata"]
  scenarios: ["Action taking free-text arguments is parsed", "Declared arity is violated"]
  verify: ["bun test tests/commands tests/e2e", "bun run typecheck"]
  manual: null
  ```

## 4. Uniform Handler Contract

- [ ] 4.1 Add the handler definition factory producing the normalized request (change name typed by the action's declaration, joined free-text argument, raw arguments, working directory, merged signal, run identity, agent-run observer, actor, memoized snapshot accessor) and attaching action and change name to the returned outcome; verify with tests covering a required-change action, a missing required change, and cancellation.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.2"]
  role: builder
  reads: ["src/runtime/**", "src/muster/**", "src/controller/**", "tests/muster/**"]
  writes: ["src/runtime/**", "tests/muster/change-handler.test.ts"]
  requirements: ["change-command-runtime: Uniform subcommand handler contract"]
  scenarios: ["Handler for an action requiring a change name", "Required change name is absent", "Invocation is cancelled"]
  verify: ["bun test tests/muster/change-handler.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.2 Rewrite all nine subcommand handlers against the factory, removing the non-null change-name assertions, repeated prompt joins, signal merges, observer forwarding, snapshot-loading expressions, and restated action and change-name fields; verify every advertised action still reaches its phase through the default registration.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1"]
  role: builder
  reads: ["src/muster/**", "src/runtime/**", "tests/**"]
  writes: ["src/muster/**", "src/runtime/dependencies.ts", "tests/e2e/production-command-assembly.test.ts"]
  requirements: ["change-command-runtime: Uniform subcommand handler contract"]
  scenarios: ["Handler for an action requiring a change name", "Required change name is absent"]
  verify: ["bun test tests/e2e tests/commands tests/muster", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.3 Populate the confirming actor from the host invocation context and confirm the verification and finish phases now forward the agent-run observer; verify by tests that a confirmed checkpoint records the host-supplied actor and that agent runs started by those two phases appear in progress and usage output.

  ```yaml harness-task
  id: "4.3"
  dependsOn: ["4.2"]
  role: builder
  reads: ["src/runtime/**", "src/muster/**", "src/controller/manual-checkpoint.ts", "tests/muster/**", "tests/recovery/**"]
  writes: ["src/runtime/**", "src/muster/**", "tests/muster/agent-progress.test.ts", "tests/muster/change-handler.test.ts"]
  requirements: ["change-command-runtime: Consistent progress and actor reporting across phases"]
  scenarios: ["Verification or finish phase starts an agent run", "Manual checkpoint is confirmed"]
  verify: ["bun test tests/muster tests/recovery", "bun run typecheck"]
  manual: null
  ```

## 5. Model Resolution and Options Seam

- [ ] 5.1 Consolidate model resolution into one resolver applying environment override, configured stack slot, command-line flag, then a single declared fallback per role; add per-role environment overrides, remove the duplicated fallback model literals, and verify precedence by test for a non-exploration role.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["4.3"]
  role: builder
  reads: ["src/runtime/**", "src/muster/**", "extensions/fusion-harness/modules/model-stack.ts", "tests/muster/**"]
  writes: ["src/runtime/**", "src/muster/**", "tests/muster/model-resolution.test.ts"]
  requirements: ["change-command-runtime: Uniform model resolution precedence"]
  scenarios: ["Environment override is set for a non-exploration role", "Model stack is configured", "Nothing is configured"]
  verify: ["bun test tests/muster/model-resolution.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 5.2 Split the runtime options bag into configuration and test overrides, narrow each substitution point to its declared inputs, and give the finish phase its own options type instead of reusing the verification phase's; verify substituted boundaries no longer receive sibling substitution points.

  ```yaml harness-task
  id: "5.2"
  dependsOn: ["5.1"]
  role: builder
  reads: ["src/runtime/**", "src/muster/**", "tests/**"]
  writes: ["src/runtime/**", "src/muster/**", "tests/muster/**", "tests/e2e/**"]
  requirements: ["change-command-runtime: Separated configuration and test overrides"]
  scenarios: ["Substitution point is invoked", "Phase options are declared"]
  verify: ["bun test tests/muster tests/e2e", "bun run typecheck"]
  manual: null
  ```

- [ ] 5.3 Remove per-invocation state construction that no handler reads, including the eager change and model-stack resolution performed for read-only actions, and verify by test that a status invocation performs no model-stack resolution and that every retained field has a consumer.

  ```yaml harness-task
  id: "5.3"
  dependsOn: ["5.2"]
  role: builder
  reads: ["src/runtime/**", "src/muster/**", "tests/**"]
  writes: ["src/runtime/**", "src/muster/**", "tests/muster/change-handler.test.ts"]
  requirements: ["change-command-runtime: No unused per-invocation state construction"]
  scenarios: ["Status is invoked", "Per-invocation value is retained"]
  verify: ["bun test tests/muster", "bun run typecheck"]
  manual: null
  ```

## 6. Verification

- [ ] 6.1 Run the full cross-platform validation set and compare the pass/fail counts against the recorded pre-existing platform baseline, confirming no new failures were introduced by any step.

  ```yaml harness-task
  id: "6.1"
  dependsOn: ["5.3"]
  role: validator
  reads: ["src/**", "tests/**", "docs/testing.md"]
  writes: []
  requirements: ["change-command-runtime: Uniform subcommand handler contract", "change-command-runtime: Single ownership of shared runtime helpers"]
  scenarios: ["Handler for an action requiring a change name", "Shared behavior changes"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run test:extension-smoke", "bun run docs:check"]
  manual: null
  ```

- [ ] 6.2 Smoke-test each phase live against a real child-process spawn, confirming transcript rendering, live progress for every phase including verification and finish, and model selection under a configured model stack.

  ```yaml harness-task
  id: "6.2"
  dependsOn: ["6.1"]
  role: manual
  reads: ["src/**", "docs/**"]
  writes: []
  requirements: ["change-command-runtime: Single transcript presentation identity", "change-command-runtime: Consistent progress and actor reporting across phases"]
  scenarios: ["Interactive host renders a phase result", "Verification or finish phase starts an agent run"]
  verify: ["bun run typecheck"]
  manual:
    category: external_side_effect
    reason: "Real child-process spawning, transcript rendering, and live widget behavior cannot be observed from the automated suite, which never spawns a child."
    instructions:
      - "Start the extension interactively with a configured model stack and a scratch change."
      - "Invoke each /change phase and confirm every phase posts a rendered transcript panel rather than a transient toast."
      - "Confirm live agent progress appears for every phase that starts an agent run, including verify and finish."
      - "Confirm the models used match the configured stack, and that a per-role environment override takes precedence over it."
    expectedOutcome: "Every phase renders a transcript panel, reports live agent progress, and selects models per the documented precedence."
    resumeTarget: "6.2"
  ```
