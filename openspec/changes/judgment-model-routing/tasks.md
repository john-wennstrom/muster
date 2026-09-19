## 1. Lane Configuration

- [ ] 1.1 Add economy lane resolution to `src/change/models.ts`: an exported function that returns the primary builder's slot copied with the model named by the `MUSTER_BUILDER_ECONOMY_MODEL` override, using the existing slot-copy helper, and returns no lane when the override is unset or blank, with no default and no inference; verify in the model-resolution tests that the lane resolves from its override, that its thinking level, prompts, and tool configuration equal the primary builder's, that an absent override yields no lane, and that every existing resolution test passes unchanged.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/change/models.ts", "tests/muster/model-resolution.test.ts"]
  writes: ["src/change/models.ts", "tests/muster/model-resolution.test.ts"]
  requirements: ["judgment-model-routing: The economy lane is explicit configuration"]
  scenarios: ["Economy lane resolves from its override", "Economy lane inherits the primary builder's configuration", "Absent override yields no lane"]
  verify: ["bun test tests/muster/model-resolution.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Decision and Routing

- [ ] 2.1 Register the `routing.task_model` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts` with its own enabling flag `MUSTER_JEV_MODEL_ROUTING`: six yes/no questions on mechanical, deep reasoning, large context, novel design, security boundary, and public contract, a four-level reach rubric, a declared effect of reducing work, and a gate that routes to the economy lane only when mechanical is above 0.8, each risk below 0.3, and reach below 1.5 at confidence 0.8; verify with tests that a mechanical low-risk task is routed and that a task fails to route when any single guard is out of band, including a security-boundary task at 0.5, a public-contract task at 0.5, a wide-reach task at 2.0, and an uncertain answer.

  ```yaml harness-task
  id: "2.1"
  dependsOn: []
  role: builder
  reads: ["src/judgment/**", "src/change/phases/task-steps/builder.ts"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "tests/judgment/model-routing.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-model-routing: A task is downgraded only when every guard holds"]
  scenarios: ["Mechanical low-risk task is routed to the economy lane", "Security-boundary task stays on the primary builder", "Public-contract task stays on the primary builder", "Wide-reach task stays on the primary builder", "Uncertain answer stays on the primary builder"]
  verify: ["bun test tests/judgment/model-routing.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Make the builder step in `src/change/phases/task-steps/builder.ts` choose its slot through an optional judgment runtime on the task step context, adding the runtime to the context if it is absent and an attempt parameter to the step: on a first attempt with routing enabled and an economy lane configured, send only the task's description, requirements, scenarios, scopes, and verification commands, use the economy lane only in enforce mode when the gate routes, and use the primary builder for any retry, in shadow mode, for every unavailable reason, and whenever routing is off; verify with tests of each of those paths, that no request is sent without the flag or without a lane or on a retry, that the state holds only the task contract, and that the builder's prompt, timeout, and result handling are unchanged.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["1.1", "2.1"]
  role: builder
  reads: ["src/change/phases/task-steps/**", "src/change/models.ts", "src/judgment/**", "tests/muster/**"]
  writes: ["src/change/phases/task-steps/builder.ts", "src/change/phases/task-steps/context.ts", "tests/muster/task-routing-step.test.ts"]
  requirements: ["judgment-model-routing: Routing is opt-in and inert without an economy lane", "judgment-model-routing: Retries never downgrade", "judgment-model-routing: Unavailable judgment yields today's routing", "judgment-model-routing: Shadow mode routes nothing and measures", "judgment-model-routing: Only the task contract is sent"]
  scenarios: ["No economy model means no routing", "No flag means no routing", "Retried task uses the primary builder", "Every unavailable reason uses the primary builder", "Disabled judgment adds no work", "Shadow routing is unchanged", "State holds only the task contract"]
  verify: ["bun test tests/muster/task-routing-step.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.3 Pass the attempt number from the scheduler's execute callback in `src/change/phases/implementation.ts` to the builder step, and reconcile each task's most recent routing record with the lane and the task's first-attempt pipeline outcome, tolerating a missing record and ignoring later attempts; verify with tests that the attempt reaches the builder step, that the outcome is recorded against the lane for a routed and a shadow-decided task, that a second attempt does not overwrite the first attempt's outcome, and that a missing record is harmless.

  ```yaml harness-task
  id: "2.3"
  dependsOn: ["2.2"]
  role: builder
  reads: ["src/change/phases/implementation.ts", "src/judgment/audit.ts", "tests/muster/**"]
  writes: ["src/change/phases/implementation.ts", "tests/muster/implementation-task-routing.test.ts"]
  requirements: ["judgment-model-routing: Routing decisions are recorded per task and reconciled"]
  scenarios: ["Task outcome is recorded against its lane"]
  verify: ["bun test tests/muster/implementation-task-routing.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.4 Add the per-lane report in `src/judgment/model-routing-report.ts` that reads this decision's records and gives, for each lane and for tasks that shadow mode would have routed, the number of tasks and the share that completed on their first attempt; verify with tests over hand-built records covering both lanes, a shadow-only population, an empty lane, and unreconciled records excluded.

  ```yaml harness-task
  id: "2.4"
  dependsOn: ["2.3"]
  role: builder
  reads: ["src/judgment/audit.ts"]
  writes: ["src/judgment/model-routing-report.ts", "tests/judgment/model-routing-report.test.ts"]
  requirements: ["judgment-model-routing: Shadow mode routes nothing and measures"]
  scenarios: ["Success rate is reported per lane"]
  verify: ["bun test tests/judgment/model-routing-report.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Documentation and Verification

- [ ] 3.1 Add the task routing row to the per-call-site table in `docs/security.md`, naming each task's description, requirements, scenarios, scopes, and verification commands and stating that no source is sent, and describe the `MUSTER_JEV_MODEL_ROUTING` flag and the `MUSTER_BUILDER_ECONOMY_MODEL` override in the README's model configuration text, stating that the economy lane exists only when configured and that the user is responsible for choosing a model that supports the builder's tools; verify the documentation checks pass.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.3"]
  role: builder
  reads: ["docs/security.md", "README.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md", "README.md"]
  requirements: ["judgment-model-routing: Routing egress and configuration are documented"]
  scenarios: ["Documentation lists the routing egress and configuration"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [ ] 3.2 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that every task uses the primary builder exactly as today with the flag or the override unset and that judgment disabled performs no routing work.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["2.4", "3.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-model-routing: Routing is opt-in and inert without an economy lane", "judgment-model-routing: Unavailable judgment yields today's routing"]
  scenarios: ["No flag means no routing", "Disabled judgment adds no work"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
