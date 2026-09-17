## 1. Invocation Context and Change Resolution

- [ ] 1.1 Define immutable command-run context, role-model assignment, output-sink, blocker, and terminal-outcome types; adapt production dependency construction to use an invocation factory and verify repository cwd, planning home, cancellation, and output are preserved in `tests/muster/production-runtime.test.ts`.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/muster/**", "src/agents/model-router.ts", "src/openspec/**", "tests/muster/**"]
  writes: ["src/muster/**", "tests/muster/production-runtime.test.ts"]
  requirements: ["production-command-assembly: Invocation-scoped runtime context", "production-command-assembly: Persistent command outcomes"]
  scenarios: ["Host invokes a command from a non-process working directory", "Command is cancelled"]
  verify: ["bun test tests/muster/production-runtime.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 1.2 Implement canonical change-slug and resolved-path validation using the OpenSpec planning home, including traversal, absolute path, invalid grammar, missing directory, symlink escape, and case/normalization collision checks; verify rejection happens before filesystem reads outside the change root or active-state writes.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/muster/**", "src/openspec/**", "src/persistence/change-usage-store.ts", "tests/muster/**"]
  writes: ["src/muster/**", "tests/muster/change-resolution.test.ts"]
  requirements: ["production-command-assembly: Safe change identity resolution"]
  scenarios: ["Traversal or absolute identifier", "Invalid slug", "Missing explicit change", "Canonical slug collision"]
  verify: ["bun test tests/muster/change-resolution.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Dispatcher and Outcome Contract

- [ ] 2.1 Refactor dispatch into explicit explore, status, propose, and existing-change paths; make explore skip active-change resolution and snapshot loading, make status read-only, and persist an active change only after a mutating action passes validation and lifecycle prerequisites.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/muster/change-command.ts", "src/controller/action-resolver.ts", "src/persistence/change-usage-store.ts", "tests/commands/change-command.test.ts"]
  writes: ["src/muster/change-command.ts", "src/muster/production-runtime.ts", "tests/commands/change-command.test.ts"]
  requirements: ["production-command-assembly: Action-aware read-only dispatch", "production-command-assembly: Safe change identity resolution"]
  scenarios: ["Explore while remembered change is corrupt", "Status names another change", "Mutating action is rejected"]
  verify: ["bun test tests/commands/change-command.test.ts tests/muster/production-runtime.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Centralize exactly-once persistent rendering for success, blocked, cancelled, and failure outcomes; map known snapshot, controller, adapter, routing, and checkpoint errors to concrete blocker details and verify unexpected errors no longer disappear as transient notifications.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/muster/**", "src/controller/**", "src/shared/errors.ts", "tests/commands/**"]
  writes: ["src/muster/**", "tests/commands/change-command.test.ts", "tests/muster/command-outcomes.test.ts"]
  requirements: ["production-command-assembly: Actionable prerequisite diagnostics", "production-command-assembly: Persistent command outcomes"]
  scenarios: ["Required artifact is absent", "Review evidence is stale", "Manual checkpoint is pending", "Required model is unavailable", "Unexpected production failure"]
  verify: ["bun test tests/commands/change-command.test.ts tests/muster/command-outcomes.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Planning and Review Assembly

- [ ] 3.1 Build invocation-scoped model-stack resolution and brokered read-only planning-agent execution for specialist, debate, and synthesis stages; fail before dispatch when a mandatory role cannot be routed and verify phase/stage prompts, fresh sessions, cancellation, usage, and model assignments.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.1", "2.2"]
  role: builder
  reads: ["src/agents/**", "src/controller/planning.ts", "src/muster/production-runtime.ts", "src/telemetry/**", "extensions/fusion-harness/modules/model-stack.ts"]
  writes: ["src/muster/production-runtime.ts", "src/muster/planning-runtime.ts", "tests/muster/planning-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Invocation-scoped runtime context", "production-command-assembly: Actionable prerequisite diagnostics"]
  scenarios: ["Advertised phase is invoked", "Required model is unavailable", "Command is cancelled"]
  verify: ["bun test tests/muster/planning-runtime.test.ts tests/commands/planning.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Assemble `propose` and `refine` handlers with deterministic complexity inputs, OpenSpec artifact instructions, change-root-scoped artifact writes, controller calls, usage persistence, and terminal outcomes; verify both handlers create only instruction-resolved artifacts and retain planning-controller gates.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/controller/planning.ts", "src/controller/complexity-router.ts", "src/openspec/**", "src/muster/**", "tests/commands/planning.test.ts"]
  writes: ["src/muster/planning-runtime.ts", "src/muster/production-runtime.ts", "tests/muster/planning-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Persistent command outcomes"]
  scenarios: ["Advertised phase is invoked", "Production prerequisite blocks a phase"]
  verify: ["bun test tests/muster/planning-runtime.test.ts tests/commands/planning.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.3 Assemble `review` with canonical artifact discovery, digest stability, author identity, eligible model candidates, a fresh brokered read-only reviewer, durable review output, usage, and an exact next action; verify approved, revise, changed-during-review, and unavailable-reviewer paths.

  ```yaml harness-task
  id: "3.3"
  dependsOn: ["3.1", "3.2"]
  role: builder
  reads: ["src/controller/review.ts", "src/review/**", "src/agents/**", "src/muster/**", "tests/commands/review.test.ts"]
  writes: ["src/muster/review-runtime.ts", "src/muster/production-runtime.ts", "tests/muster/review-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Actionable prerequisite diagnostics"]
  scenarios: ["Advertised phase is invoked", "Required model is unavailable", "Production prerequisite blocks a phase"]
  verify: ["bun test tests/muster/review-runtime.test.ts tests/commands/review.test.ts", "bun run typecheck"]
  manual: null
  ```

## 4. Implementation and Resume Assembly

- [ ] 4.1 Build the implementation-run preparer that loads typed apply instructions, parses structured tasks, compiles the dependency DAG, selects or creates the controller-owned worktree, creates or validates the run manifest, loads persisted evidence, and produces a recovery plan; verify identity mismatch, stale review, corrupt evidence, and missing worktree fail closed.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["2.2", "3.3"]
  role: builder
  reads: ["src/openspec/**", "src/execution/**", "src/controller/recovery.ts", "src/persistence/**", "src/review/**", "tests/execution/**", "tests/recovery/**"]
  writes: ["src/muster/implementation-runtime.ts", "tests/muster/implementation-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Actionable prerequisite diagnostics"]
  scenarios: ["Review evidence is stale", "Production prerequisite blocks a phase"]
  verify: ["bun test tests/muster/implementation-runtime.test.ts tests/execution/task-pipeline.test.ts tests/recovery/reconciliation.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.2 Assemble production task execution with fresh brokered builders and reviewers, task capsules, role/path authorization, audited host commands, TDD/debugging policies, global writer leasing, scheduler cancellation, evidence persistence, and checkbox synchronization; verify no legacy executor bypasses these gates.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1"]
  role: builder
  reads: ["src/agents/**", "src/context/**", "src/execution/**", "src/policies/**", "src/review/code-review.ts", "src/tools/**", "src/persistence/**"]
  writes: ["src/muster/implementation-runtime.ts", "tests/muster/implementation-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Invocation-scoped runtime context"]
  scenarios: ["Advertised phase is invoked", "Production prerequisite blocks a phase", "Command is cancelled"]
  verify: ["bun test tests/muster/implementation-runtime.test.ts tests/execution/implementation-flow.test.ts tests/agents/tool-boundary.test.ts tests/tools/host-runner.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.3 Wire the `implement` handler to the implementation controller using the prepared production flow and persist success, blocked, design-conflict, awaiting-user, cancelled, and failed run states with exact next actions.

  ```yaml harness-task
  id: "4.3"
  dependsOn: ["4.2"]
  role: builder
  reads: ["src/controller/implement.ts", "src/muster/implementation-runtime.ts", "src/persistence/**", "tests/commands/implement.test.ts"]
  writes: ["src/muster/implementation-runtime.ts", "src/muster/production-runtime.ts", "tests/muster/implementation-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Persistent command outcomes"]
  scenarios: ["Advertised phase is invoked", "Production prerequisite blocks a phase", "Manual checkpoint is pending"]
  verify: ["bun test tests/muster/implementation-runtime.test.ts tests/commands/implement.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.4 Wire `resume` to validate one pending checkpoint, confirm it atomically with the invocation actor, execute the corresponding recovery action, and continue through the same production implementation flow; verify unknown, mismatched, already-confirmed, and multiple-pending checkpoint guidance.

  ```yaml harness-task
  id: "4.4"
  dependsOn: ["4.3"]
  role: builder
  reads: ["src/controller/implement.ts", "src/controller/manual-checkpoint.ts", "src/controller/recovery.ts", "src/muster/implementation-runtime.ts", "src/persistence/**"]
  writes: ["src/muster/implementation-runtime.ts", "src/muster/production-runtime.ts", "tests/muster/resume-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Actionable prerequisite diagnostics"]
  scenarios: ["Manual checkpoint is pending", "Advertised phase is invoked"]
  verify: ["bun test tests/muster/resume-runtime.test.ts tests/manual/resume.test.ts tests/commands/implement.test.ts", "bun run typecheck"]
  manual: null
  ```

## 5. Verification and Finish Assembly

- [ ] 5.1 Build production final-validation collectors for typed OpenSpec validation, tasks, persisted manifests/evidence, required test commands, unresolved findings, design alignment, review/source freshness, dependency reports, and Git/worktree state; verify unavailable or inconsistent inputs produce named failing gates rather than synthetic success.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["4.3"]
  role: builder
  reads: ["src/review/validator.ts", "src/openspec/**", "src/execution/**", "src/persistence/**", "src/controller/verify.ts", "tests/review/validator.test.ts"]
  writes: ["src/muster/verification-runtime.ts", "tests/muster/verification-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Actionable prerequisite diagnostics"]
  scenarios: ["Required artifact is absent", "Review evidence is stale", "Production prerequisite blocks a phase"]
  verify: ["bun test tests/muster/verification-runtime.test.ts tests/review/validator.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 5.2 Wire `verify` to run the production collectors through the verification controller, write digest-bound `verification.md`, persist validation evidence and usage, and return `finish` only on PASS; verify PASS, FAIL, stale digest, cancellation, and artifact-write failure outcomes.

  ```yaml harness-task
  id: "5.2"
  dependsOn: ["5.1"]
  role: builder
  reads: ["src/controller/verify.ts", "src/muster/verification-runtime.ts", "src/review/verification-artifact.ts", "tests/commands/verify-finish.test.ts"]
  writes: ["src/muster/verification-runtime.ts", "src/muster/production-runtime.ts", "tests/muster/verification-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Persistent command outcomes"]
  scenarios: ["Advertised phase is invoked", "Production prerequisite blocks a phase", "Command is cancelled"]
  verify: ["bun test tests/muster/verification-runtime.test.ts tests/commands/verify-finish.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 5.3 Wire `finish` to recompute current artifact and source digests, call the finish controller, and delegate the sole archive side effect to the typed OpenSpec adapter; verify failed/stale verification never archives and successful finish emits the archive result.

  ```yaml harness-task
  id: "5.3"
  dependsOn: ["5.2"]
  role: builder
  reads: ["src/controller/finish.ts", "src/openspec/**", "src/review/**", "src/execution/change-digests.ts", "src/muster/**"]
  writes: ["src/muster/verification-runtime.ts", "src/muster/production-runtime.ts", "tests/muster/finish-runtime.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Actionable prerequisite diagnostics"]
  scenarios: ["Advertised phase is invoked", "Review evidence is stale", "Production prerequisite blocks a phase"]
  verify: ["bun test tests/muster/finish-runtime.test.ts tests/commands/verify-finish.test.ts", "bun run typecheck"]
  manual: null
  ```

## 6. Default Registration Acceptance

- [ ] 6.1 Change default `registerMuster()` wiring to create an invocation-scoped production runtime while preserving an explicit injected-dependency compatibility seam; verify registered commands use the host cwd and advertised actions cannot be registered without handlers.

  ```yaml harness-task
  id: "6.1"
  dependsOn: ["3.2", "3.3", "4.4", "5.3"]
  role: builder
  reads: ["src/muster/index.ts", "src/muster/change-command.ts", "src/muster/production-runtime.ts", "tests/extension/install-smoke.test.ts"]
  writes: ["src/muster/index.ts", "src/muster/change-command.ts", "src/muster/production-runtime.ts", "tests/extension/install-smoke.test.ts"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Invocation-scoped runtime context"]
  scenarios: ["Host invokes a command from a non-process working directory", "Advertised phase is invoked"]
  verify: ["bun test tests/extension/install-smoke.test.ts tests/muster/production-runtime.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 6.2 Add a fixture-backed acceptance sweep that invokes every advertised action through default `registerMuster()` dependencies, replaces only external process/model ports, and asserts exactly one persistent success, blocked, cancelled, or failure result plus controller-specific evidence and no missing-handler or legacy fallback.

  ```yaml harness-task
  id: "6.2"
  dependsOn: ["6.1"]
  role: validator
  reads: ["src/**", "tests/fixtures/**", "openspec/changes/production-command-assembly/**"]
  writes: ["tests/e2e/production-command-assembly.test.ts", "tests/fixtures/projects/production-command-assembly/**"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Persistent command outcomes"]
  scenarios: ["Default registration acceptance sweep", "Advertised phase is invoked", "Unexpected production failure"]
  verify: ["bun test tests/e2e/production-command-assembly.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 6.3 Run the focused command/runtime suites, the complete Bun suite, typecheck, and strict OpenSpec validation; update `docs/roadmap.md` P0.1 checkboxes only for behavior proven by the acceptance sweep and record any remaining platform limitation instead of marking acceptance complete.

  ```yaml harness-task
  id: "6.3"
  dependsOn: ["6.2"]
  role: validator
  reads: ["src/**", "tests/**", "docs/roadmap.md", "openspec/changes/production-command-assembly/**"]
  writes: ["docs/roadmap.md"]
  requirements: ["production-command-assembly: Complete production command surface", "production-command-assembly: Safe change identity resolution", "production-command-assembly: Action-aware read-only dispatch", "production-command-assembly: Actionable prerequisite diagnostics", "production-command-assembly: Persistent command outcomes"]
  scenarios: ["Default registration acceptance sweep", "Traversal or absolute identifier", "Explore while remembered change is corrupt", "Status names another change", "Manual checkpoint is pending", "Command is cancelled"]
  verify: ["bun test tests/commands tests/muster tests/e2e/production-command-assembly.test.ts", "bun test", "bun run typecheck", "openspec validate production-command-assembly --strict"]
  manual: null
  ```
