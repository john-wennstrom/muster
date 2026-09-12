## 1. Import and Characterize the Foundation

- [ ] 1.1 Import Fusion Harness commit `51f1d85499a1292cb79036d6ae237db7ea52096e`, excluding Git history, dependencies, secrets, and local state; add the required notice to `THIRD_PARTY_NOTICES.md`; verify the imported file manifest and notice text.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["../fusion-harness/**"]
  writes: ["extensions/**", "prompts/**", "images/**", "ai_docs/**", "package.json", "package-lock.json", "THIRD_PARTY_NOTICES.md", ".gitignore"]
  requirements: ["project-foundation: Canonical implementation repository", "project-foundation: Licensed Fusion snapshot import"]
  scenarios: ["Run without the import source", "Distribution contains required notice"]
  verify: ["bun run verify:import"]
  manual: null
  ```

- [ ] 1.2 Establish the Node.js 22, Bun, TypeScript, ESM package baseline and deterministic scripts; verify dependency installation, type checking, and package metadata with `bun install --frozen-lockfile && bun run typecheck`.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["package.json", "extensions/**"]
  writes: ["package.json", "bun.lock", "tsconfig.json", "src/**", "tests/**"]
  requirements: ["project-foundation: Supported runtime baseline", "project-foundation: One extension distribution"]
  scenarios: ["Platform verification matrix", "Extension discovery"]
  verify: ["bun install --frozen-lockfile", "bun run typecheck"]
  manual: null
  ```

- [ ] 1.3 Preserve imported Fusion behavior as characterization coverage; verify the original command, routing, DAG, OpenSpec, writer-lease, and token-accounting tests pass unchanged with `bun test extensions/fusion-harness/tests`.

  ```yaml harness-task
  id: "1.3"
  dependsOn: ["1.2"]
  role: builder
  reads: ["extensions/fusion-harness/**"]
  writes: ["extensions/fusion-harness/tests/**", "tests/fixtures/fusion-baseline/**"]
  requirements: ["project-foundation: Incremental compatibility migration"]
  scenarios: ["Legacy workflow invocation"]
  verify: ["bun test extensions/fusion-harness/tests"]
  manual: null
  ```

- [ ] 1.4 Add a single-extension entry point and installation smoke harness while retaining compatibility exports; verify one extension registers Fusion and placeholder `/change` commands without the sibling checkout.

  ```yaml harness-task
  id: "1.4"
  dependsOn: ["1.3"]
  role: builder
  reads: ["extensions/fusion-harness/**", "src/**"]
  writes: ["src/extension/**", "extensions/**", "tests/extension/**", "package.json"]
  requirements: ["project-foundation: Canonical implementation repository", "project-foundation: One extension distribution"]
  scenarios: ["Run without the import source", "Extension discovery"]
  verify: ["bun test tests/extension"]
  manual: null
  ```

## 2. Establish the Typed OpenSpec Contract

- [ ] 2.1 Add a cancellable process runner, structured error taxonomy, and Zod schemas for OpenSpec context/status/instructions/apply/validate/archive payloads; verify valid and malformed fixtures with `bun test tests/openspec/protocol.test.ts`.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.4"]
  role: builder
  reads: ["extensions/fusion-harness/modules/openspec-workflow.ts", "openspec/**"]
  writes: ["src/openspec/**", "src/shared/**", "tests/openspec/**", "package.json", "bun.lock"]
  requirements: ["openspec-contract: Typed structured responses", "openspec-contract: Explicit OpenSpec failures"]
  scenarios: ["Malformed OpenSpec JSON", "Required artifact is absent"]
  verify: ["bun test tests/openspec/protocol.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Implement the OpenSpec capability handshake and diagnostics without exact-version gating; verify compatible-unknown and missing-capability fixtures with `bun test tests/openspec/handshake.test.ts`.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/openspec/**", "tests/fixtures/openspec/**"]
  writes: ["src/openspec/**", "tests/openspec/**", "tests/fixtures/openspec/**"]
  requirements: ["openspec-contract: Capability handshake"]
  scenarios: ["Compatible unrecognized version", "Missing required capability"]
  verify: ["bun test tests/openspec/handshake.test.ts"]
  manual: null
  ```

- [ ] 2.3 Implement typed detect, status, artifact/apply instructions, validate, and archive adapter methods with explicit cwd and timeouts; verify command arguments, cancellation, stderr, and payload validation with `bun test tests/openspec/adapter.test.ts`.

  ```yaml harness-task
  id: "2.3"
  dependsOn: ["2.2"]
  role: builder
  reads: ["src/openspec/**", "extensions/fusion-harness/modules/openspec-workflow.ts"]
  writes: ["src/openspec/**", "tests/openspec/**"]
  requirements: ["openspec-contract: Typed structured responses", "openspec-contract: OpenSpec-managed archive", "openspec-contract: Explicit OpenSpec failures"]
  scenarios: ["Malformed OpenSpec JSON", "Finish an accepted change", "Required artifact is absent"]
  verify: ["bun test tests/openspec/adapter.test.ts"]
  manual: null
  ```

- [ ] 2.4 Add and package the `fusion-driven` schema with proposal/specs/design/tasks/review/verification dependencies and apply tracking; verify schema status and instructions in an isolated fixture project.

  ```yaml harness-task
  id: "2.4"
  dependsOn: ["2.3"]
  role: builder
  reads: ["openspec/**", "src/openspec/**"]
  writes: ["schemas/fusion-driven/**", "tests/openspec/schema.test.ts", "tests/fixtures/projects/**", "package.json"]
  requirements: ["openspec-contract: Sole durable development contract", "openspec-contract: Harness change schema"]
  scenarios: ["Complete change artifact set", "New harness-controlled change"]
  verify: ["bun test tests/openspec/schema.test.ts"]
  manual: null
  ```

- [ ] 2.5 Centralize OpenSpec/repository precedence and remove human-output inference from migrated workflow paths; verify conflicting memory/runtime fixtures resolve to current durable state.

  ```yaml harness-task
  id: "2.5"
  dependsOn: ["2.4"]
  role: builder
  reads: ["src/openspec/**", "extensions/fusion-harness/**"]
  writes: ["src/controller/**", "src/openspec/**", "tests/controller/precedence.test.ts"]
  requirements: ["openspec-contract: Sole durable development contract", "openspec-contract: OpenSpec state precedence"]
  scenarios: ["Complete change artifact set", "Memory conflicts with current specification"]
  verify: ["bun test tests/controller/precedence.test.ts"]
  manual: null
  ```

## 3. Add Runtime Persistence and Baseline Telemetry

- [ ] 3.1 Implement schema-versioned atomic JSON persistence under `.fusion/runs/<run-id>` and default ignore rules; verify interrupted writes preserve the last valid record on all available local filesystem fixtures.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.4"]
  role: builder
  reads: ["extensions/fusion-harness/modules/runtime.ts", ".gitignore"]
  writes: ["src/persistence/**", "tests/persistence/**", ".gitignore"]
  requirements: ["runtime-recovery: Per-run persistent state", "runtime-recovery: Runtime data is non-authoritative", "runtime-recovery: Atomic state transitions"]
  scenarios: ["Run starts", "Manifest conflicts with completed OpenSpec task", "Process exits during state write"]
  verify: ["bun test tests/persistence/atomic-store.test.ts"]
  manual: null
  ```

- [ ] 3.2 Define run manifest, task result, review, validation, checkpoint, and migration schemas; verify unsupported versions and corrupt records fail closed with path-specific diagnostics.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/persistence/**", "openspec/changes/build-openspec-multi-agent-harness/design.md"]
  writes: ["src/persistence/**", "src/domain/**", "tests/persistence/schema.test.ts"]
  requirements: ["runtime-recovery: Per-run persistent state", "runtime-recovery: Corruption fails closed"]
  scenarios: ["Run starts", "Manifest cannot be parsed"]
  verify: ["bun test tests/persistence/schema.test.ts"]
  manual: null
  ```

- [ ] 3.3 Add provider-faithful usage records and baseline-compatible run aggregation around existing child execution; verify missing-cost, cache-token, duration, and model-assignment cases.

  ```yaml harness-task
  id: "3.3"
  dependsOn: ["3.2"]
  role: builder
  reads: ["extensions/fusion-harness/modules/runtime.ts", "src/persistence/**"]
  writes: ["src/telemetry/**", "src/agents/**", "tests/telemetry/usage.test.ts"]
  requirements: ["telemetry-and-cost: Per-invocation usage ledger", "telemetry-and-cost: Evidence-based optimization claims"]
  scenarios: ["Provider omits cost", "Insufficient comparative data"]
  verify: ["bun test tests/telemetry/usage.test.ts"]
  manual: null
  ```

- [ ] 3.4 Implement reconciliation-driven recovery across OpenSpec, Git, worktree, evidence, child, lease, and checkpoint state; verify source writes are not duplicated after interruption.

  ```yaml harness-task
  id: "3.4"
  dependsOn: ["2.5", "3.2"]
  role: builder
  reads: ["src/openspec/**", "src/persistence/**", "src/domain/**"]
  writes: ["src/persistence/**", "src/controller/**", "tests/recovery/**"]
  requirements: ["runtime-recovery: Idempotent recovery", "runtime-recovery: Resume supported interruption points", "runtime-recovery: Corruption fails closed"]
  scenarios: ["Crash after source write before task state update", "Restart after passing task review", "Manifest cannot be parsed"]
  verify: ["bun test tests/recovery"]
  manual: null
  ```

- [ ] 3.5 Add deterministic fault injection at every supported interruption point; verify recovery state transitions and immutable evidence with `bun test tests/recovery/fault-matrix.test.ts`.

  ```yaml harness-task
  id: "3.5"
  dependsOn: ["3.4"]
  role: builder
  reads: ["src/persistence/**", "src/controller/**"]
  writes: ["tests/recovery/**", "tests/helpers/**"]
  requirements: ["runtime-recovery: Atomic state transitions", "runtime-recovery: Idempotent recovery", "runtime-recovery: Resume supported interruption points"]
  scenarios: ["Process exits during state write", "Crash after source write before task state update", "Restart after passing task review"]
  verify: ["bun test tests/recovery/fault-matrix.test.ts"]
  manual: null
  ```

## 4. Implement Review Freshness and Lifecycle Control

- [ ] 4.1 Implement canonical reviewed-artifact discovery and SHA-256 streaming over sorted paths, lengths, and bytes; verify path-order, line-ending, content, and runtime-file cases.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["2.5"]
  role: builder
  reads: ["src/openspec/**", "openspec/changes/**"]
  writes: ["src/review/**", "tests/review/digest.test.ts"]
  requirements: ["review-and-verification: Deterministic artifact digest"]
  scenarios: ["Reviewed content is unchanged", "Reviewed artifact changes"]
  verify: ["bun test tests/review/digest.test.ts"]
  manual: null
  ```

- [ ] 4.2 Define, parse, validate, and atomically write the durable binary `review.md` contract; verify required findings produce `REVISE` and unsupported verdicts are rejected.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1", "3.2"]
  role: builder
  reads: ["src/review/**", "src/persistence/**"]
  writes: ["src/review/**", "tests/review/artifact.test.ts"]
  requirements: ["review-and-verification: Binary planning verdict", "review-and-verification: Deterministic artifact digest"]
  scenarios: ["Reviewer identifies required correction", "Reviewed artifact changes"]
  verify: ["bun test tests/review/artifact.test.ts"]
  manual: null
  ```

- [ ] 4.3 Implement fresh read-only planning reviewer dispatch with author-session isolation and different-model preference; verify tool denial and model assignment evidence.

  ```yaml harness-task
  id: "4.3"
  dependsOn: ["4.2", "3.3"]
  role: builder
  reads: ["extensions/fusion-harness/**", "src/review/**", "src/agents/**"]
  writes: ["src/review/**", "src/agents/**", "tests/review/reviewer.test.ts"]
  requirements: ["review-and-verification: Fresh read-only planning review", "agent-runtime: Independent review context"]
  scenarios: ["Planning artifacts are ready", "Multiple eligible models"]
  verify: ["bun test tests/review/reviewer.test.ts"]
  manual: null
  ```

- [ ] 4.4 Implement `ChangeSnapshot` collection and the controller lifecycle state machine with freshness invalidation; verify legal/illegal transitions and mixed-state snapshots.

  ```yaml harness-task
  id: "4.4"
  dependsOn: ["3.4", "4.2"]
  role: builder
  reads: ["src/controller/**", "src/openspec/**", "src/persistence/**", "src/review/**"]
  writes: ["src/controller/**", "src/domain/**", "tests/controller/state-machine.test.ts"]
  requirements: ["change-workflows: Derived lifecycle state", "change-workflows: Prerequisite-directed commands"]
  scenarios: ["Runtime says approved but digest is stale", "Implement before review"]
  verify: ["bun test tests/controller/state-machine.test.ts"]
  manual: null
  ```

- [ ] 4.5 Implement auditable direct/bounded/architectural classification and optional-reasoning policy; verify deterministic signals, overrides, and mandatory-gate preservation.

  ```yaml harness-task
  id: "4.5"
  dependsOn: ["4.4"]
  role: builder
  reads: ["src/controller/**", "src/telemetry/**"]
  writes: ["src/controller/complexity-router.ts", "src/policies/**", "tests/controller/complexity-router.test.ts"]
  requirements: ["change-workflows: Risk-scaled orchestration", "policy-enforcement: Mandatory gates survive budget pressure"]
  scenarios: ["Localized low-risk task", "Cross-cutting ambiguous change", "Budget is exhausted before review"]
  verify: ["bun test tests/controller/complexity-router.test.ts"]
  manual: null
  ```

## 5. Compile Structured Tasks into a Runtime DAG

- [ ] 5.1 Replace regex task parsing with Markdown AST plus fenced YAML association; verify headings, checkboxes, adjacency, duplicate blocks, and source locations.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["2.5"]
  role: builder
  reads: ["extensions/fusion-harness/modules/openspec-workflow.ts", "openspec/changes/build-openspec-multi-agent-harness/tasks.md"]
  writes: ["src/execution/task-parser.ts", "tests/execution/task-parser.test.ts", "package.json", "bun.lock"]
  requirements: ["task-orchestration: Structured task execution metadata"]
  scenarios: ["Task metadata is incomplete", "Checkbox and metadata identifiers differ"]
  verify: ["bun test tests/execution/task-parser.test.ts"]
  manual: null
  ```

- [ ] 5.2 Validate task metadata identifiers, roles, normalized scopes, requirement/scenario links, verification commands, and manual contracts; verify field-specific failures before dispatch.

  ```yaml harness-task
  id: "5.2"
  dependsOn: ["5.1"]
  role: builder
  reads: ["src/execution/task-parser.ts", "src/openspec/**"]
  writes: ["src/execution/task-schema.ts", "src/execution/task-parser.ts", "tests/execution/task-schema.test.ts"]
  requirements: ["task-orchestration: Structured task execution metadata", "manual-interaction: Planned manual task contract"]
  scenarios: ["Task metadata is incomplete", "Checkbox and metadata identifiers differ", "Planned manual task becomes eligible"]
  verify: ["bun test tests/execution/task-schema.test.ts"]
  manual: null
  ```

- [ ] 5.3 Compile and persist an immutable DAG snapshot tied to the tasks digest; verify cycles, unknown dependencies, removed tasks, dependency closure, and deterministic ordering.

  ```yaml harness-task
  id: "5.3"
  dependsOn: ["5.2", "3.2"]
  role: builder
  reads: ["src/execution/**", "src/persistence/**"]
  writes: ["src/execution/delegation-dag.ts", "src/persistence/**", "tests/execution/dag.test.ts"]
  requirements: ["task-orchestration: Derived dependency DAG"]
  scenarios: ["Dependency cycle"]
  verify: ["bun test tests/execution/dag.test.ts"]
  manual: null
  ```

- [ ] 5.4 Implement dependency-ready scheduling, read concurrency, write queuing hooks, branch blocking, retries, and cancellation; verify ordering and no dependent dispatch after failure.

  ```yaml harness-task
  id: "5.4"
  dependsOn: ["5.3", "4.4"]
  role: builder
  reads: ["extensions/fusion-harness/modules/cmd-build.ts", "src/execution/**", "src/controller/**"]
  writes: ["src/execution/scheduler.ts", "tests/execution/scheduler.test.ts"]
  requirements: ["task-orchestration: Safe read concurrency", "task-orchestration: Dependency and gate ordering"]
  scenarios: ["Independent analysis task", "Focused test failure"]
  verify: ["bun test tests/execution/scheduler.test.ts"]
  manual: null
  ```

- [ ] 5.5 Implement structured completed/blocked/awaiting-user/design-conflict outcomes and evidence-gated task checkbox synchronization; verify conflicts invalidate affected review and claims alone never complete tasks.

  ```yaml harness-task
  id: "5.5"
  dependsOn: ["5.4", "4.4"]
  role: builder
  reads: ["src/execution/**", "src/controller/**", "src/review/**"]
  writes: ["src/execution/task-runner.ts", "src/controller/**", "tests/execution/outcomes.test.ts"]
  requirements: ["task-orchestration: Design conflict outcome", "task-orchestration: Durable task completion synchronization"]
  scenarios: ["Repository contradicts approved design", "Agent claims completion without evidence"]
  verify: ["bun test tests/execution/outcomes.test.ts"]
  manual: null
  ```

## 6. Introduce Worktrees and Durable Writer Ownership

- [ ] 6.1 Implement a cross-platform Git adapter for repository identity, common directory, status, refs, diffs, and worktree porcelain; verify spaces, symlinks, detached heads, and Windows path fixtures.

  ```yaml harness-task
  id: "6.1"
  dependsOn: ["1.4"]
  role: builder
  reads: ["src/**", "tests/fixtures/git/**"]
  writes: ["src/execution/git.ts", "tests/execution/git.test.ts", "tests/fixtures/git/**"]
  requirements: ["task-orchestration: Controller-owned dedicated worktree"]
  scenarios: ["Implement from the planning checkout", "Repository cannot support worktrees"]
  verify: ["bun test tests/execution/git.test.ts"]
  manual: null
  ```

- [ ] 6.2 Implement deterministic controller-owned change worktree create/select/reuse behavior and forbid child worktree operations; verify dirty planning checkout isolation and safe reuse.

  ```yaml harness-task
  id: "6.2"
  dependsOn: ["6.1", "3.2"]
  role: builder
  reads: ["src/execution/git.ts", "src/persistence/**"]
  writes: ["src/execution/worktree.ts", "src/persistence/**", "tests/execution/worktree.test.ts"]
  requirements: ["task-orchestration: Controller-owned dedicated worktree"]
  scenarios: ["Implement from the planning checkout", "Repository cannot support worktrees"]
  verify: ["bun test tests/execution/worktree.test.ts"]
  manual: null
  ```

- [ ] 6.3 Upgrade the writer lease to repository/worktree/run/task identity with live-owner rejection and reconciled stale recovery; verify concurrent writers, normal release, crash recovery, and false-stale protection.

  ```yaml harness-task
  id: "6.3"
  dependsOn: ["6.2", "3.4"]
  role: builder
  reads: ["extensions/fusion-harness/modules/writer-lease.ts", "src/persistence/**", "src/execution/**"]
  writes: ["src/execution/writer-lease.ts", "tests/execution/writer-lease.test.ts"]
  requirements: ["task-orchestration: Global source-writer lease", "runtime-recovery: Recoverable writer ownership"]
  scenarios: ["Concurrent write-ready tasks", "Stale lease after crash"]
  verify: ["bun test tests/execution/writer-lease.test.ts"]
  manual: null
  ```

- [ ] 6.4 Integrate worktree selection and writer leasing into the scheduler while preserving concurrent reads; verify two ready writers serialize and independent readers overlap.

  ```yaml harness-task
  id: "6.4"
  dependsOn: ["5.4", "6.3"]
  role: builder
  reads: ["src/execution/**"]
  writes: ["src/execution/scheduler.ts", "src/execution/task-runner.ts", "tests/execution/concurrency.test.ts"]
  requirements: ["task-orchestration: Global source-writer lease", "task-orchestration: Safe read concurrency"]
  scenarios: ["Concurrent write-ready tasks", "Independent analysis task"]
  verify: ["bun test tests/execution/concurrency.test.ts"]
  manual: null
  ```

## 7. Enforce Brokered Tools and Host Command Controls

- [ ] 7.1 Define authenticated, cancellable parent/child tool-broker messages, correlation IDs, audit events, output bounds, and protocol-version negotiation; verify spoofed and malformed requests are rejected.

  ```yaml harness-task
  id: "7.1"
  dependsOn: ["3.2", "6.4"]
  role: builder
  reads: ["extensions/fusion-harness/modules/child-runner.ts", "src/domain/**"]
  writes: ["src/tools/protocol.ts", "src/agents/broker-client.ts", "tests/tools/protocol.test.ts"]
  requirements: ["policy-enforcement: Process and tool enforcement"]
  scenarios: ["Read-only reviewer attempts a write"]
  verify: ["bun test tests/tools/protocol.test.ts"]
  manual: null
  ```

- [ ] 7.2 Implement centralized role/tool/path authorization with canonical path, symlink, case, lease, and task-state checks; verify shell, patch, Serena, and traversal attempts cannot escape scope.

  ```yaml harness-task
  id: "7.2"
  dependsOn: ["7.1"]
  role: builder
  reads: ["src/tools/**", "src/execution/writer-lease.ts"]
  writes: ["src/tools/authorization.ts", "tests/tools/authorization.test.ts"]
  requirements: ["policy-enforcement: Process and tool enforcement", "policy-enforcement: Scoped source writes"]
  scenarios: ["Read-only reviewer attempts a write", "Builder writes outside its scope"]
  verify: ["bun test tests/tools/authorization.test.ts"]
  manual: null
  ```

- [ ] 7.3 Implement cross-platform structured command profiles, executable allowlists, argument-array spawning, working-directory validation, and environment minimization; verify unsupported profiles and shell escalation are rejected.

  ```yaml harness-task
  id: "7.3"
  dependsOn: ["7.2"]
  role: builder
  reads: ["src/tools/**", "src/execution/**"]
  writes: ["src/tools/command-profile.ts", "src/tools/host-runner.ts", "tests/tools/command-profile.test.ts"]
  requirements: ["policy-enforcement: Host command execution controls"]
  scenarios: ["Host command exceeds its boundary", "User inspects beta isolation"]
  verify: ["bun test tests/tools/command-profile.test.ts"]
  manual: null
  ```

- [ ] 7.4 Implement brokered host command/test execution with timeout, output bounds, cancellation and process cleanup, prohibited-action preflight, Git state capture, and post-command scope audit; verify violations cannot produce accepted task evidence.

  ```yaml harness-task
  id: "7.4"
  dependsOn: ["7.3"]
  role: builder
  reads: ["src/tools/**", "src/execution/**"]
  writes: ["src/tools/host-runner.ts", "src/tools/command-audit.ts", "tests/tools/host-runner.test.ts", "tests/fixtures/commands/**"]
  requirements: ["policy-enforcement: Host command execution controls", "policy-enforcement: Scoped source writes", "policy-enforcement: Prohibited operation interception"]
  scenarios: ["Host command exceeds its boundary", "Builder writes outside its scope", "Builder proposes force push"]
  verify: ["bun test tests/tools/host-runner.test.ts"]
  manual: null
  ```

- [ ] 7.5 Add the clean-room Pi child broker extension and role-specific read/write/command tools without direct built-in mutation or shell access; verify reviewer writes are denied before reaching the host filesystem.

  ```yaml harness-task
  id: "7.5"
  dependsOn: ["7.4"]
  role: builder
  reads: ["extensions/fusion-harness/modules/child-runner.ts", "src/agents/**", "src/tools/**"]
  writes: ["src/extension/child-broker.ts", "src/agents/child-runner.ts", "tests/agents/tool-boundary.test.ts"]
  requirements: ["policy-enforcement: Process and tool enforcement", "policy-enforcement: Scoped source writes"]
  scenarios: ["Read-only reviewer attempts a write", "Builder writes outside its scope"]
  verify: ["bun test tests/agents/tool-boundary.test.ts"]
  manual: null
  ```

- [ ] 7.6 Migrate architect, builder, reviewer, and validator execution to brokered tools while retaining compatibility command behavior; verify the imported command characterization suite plus broker integration tests.

  ```yaml harness-task
  id: "7.6"
  dependsOn: ["7.5", "4.3"]
  role: builder
  reads: ["extensions/fusion-harness/**", "src/agents/**", "src/tools/**"]
  writes: ["src/agents/**", "src/review/**", "src/extension/**", "extensions/fusion-harness/**", "tests/agents/**"]
  requirements: ["project-foundation: Incremental compatibility migration", "policy-enforcement: Process and tool enforcement"]
  scenarios: ["Legacy workflow invocation", "Read-only reviewer attempts a write"]
  verify: ["bun test extensions/fusion-harness/tests", "bun test tests/agents"]
  manual: null
  ```

- [ ] 7.7 Add adversarial broker and host-runner tests for traversal, symlinks, environment leakage, shell escalation, prohibited commands, unauthorized Git, out-of-scope diffs, output flooding, timeout, and cancellation; verify violations are blocked or rejected and audited.

  ```yaml harness-task
  id: "7.7"
  dependsOn: ["7.6"]
  role: builder
  reads: ["src/tools/**", "src/agents/**"]
  writes: ["tests/security/**", "tests/fixtures/commands/**"]
  requirements: ["policy-enforcement: Process and tool enforcement", "policy-enforcement: Host command execution controls", "policy-enforcement: Prohibited operation interception"]
  scenarios: ["Read-only reviewer attempts a write", "Host command exceeds its boundary", "User inspects beta isolation", "Builder proposes force push"]
  verify: ["bun test tests/security"]
  manual: null
  ```

## 8. Add Fresh Agents, Context Capsules, and Routing

- [ ] 8.1 Replace persistent role conversations with fresh architect/builder/reviewer/validator run creation and structured dependency reports; verify consecutive tasks do not inherit transcripts.

  ```yaml harness-task
  id: "8.1"
  dependsOn: ["7.6", "5.5"]
  role: builder
  reads: ["src/agents/**", "extensions/fusion-harness/**"]
  writes: ["src/agents/role-runner.ts", "src/agents/reports.ts", "tests/agents/fresh-context.test.ts"]
  requirements: ["agent-runtime: Fresh role contexts", "agent-runtime: Compact inter-agent handoff"]
  scenarios: ["Consecutive builder tasks", "Builder dependency completes"]
  verify: ["bun test tests/agents/fresh-context.test.ts"]
  manual: null
  ```

- [ ] 8.2 Implement required/relevant/available/excluded context assembly and task capsules with non-truncatable contracts; verify budget pressure removes optional context first.

  ```yaml harness-task
  id: "8.2"
  dependsOn: ["8.1", "5.2"]
  role: builder
  reads: ["src/agents/**", "src/openspec/**", "src/execution/**"]
  writes: ["src/context/**", "tests/context/assembler.test.ts"]
  requirements: ["agent-runtime: Task-scoped context capsules", "agent-runtime: Context priority"]
  scenarios: ["Builder needs omitted context", "Capsule exceeds budget"]
  verify: ["bun test tests/context/assembler.test.ts"]
  manual: null
  ```

- [ ] 8.3 Add authorized context escalation and compact decision/dependency capsules with usage accounting; verify unrelated transcripts remain excluded and denied requests are explicit.

  ```yaml harness-task
  id: "8.3"
  dependsOn: ["8.2", "3.3"]
  role: builder
  reads: ["src/context/**", "src/telemetry/**", "src/agents/**"]
  writes: ["src/context/**", "src/agents/reports.ts", "tests/context/escalation.test.ts"]
  requirements: ["agent-runtime: Task-scoped context capsules", "agent-runtime: Compact inter-agent handoff"]
  scenarios: ["Builder needs omitted context", "Builder dependency completes"]
  verify: ["bun test tests/context/escalation.test.ts"]
  manual: null
  ```

- [ ] 8.4 Refactor Fusion model-stack resolution behind a capability/cost router, require an available OpenAI model for beta checks, and report Copilot as unavailable without an adapter; verify provider fixtures and assignments.

  ```yaml harness-task
  id: "8.4"
  dependsOn: ["8.1", "3.3"]
  role: builder
  reads: ["extensions/fusion-harness/modules/model-stack.ts", "src/agents/**", "src/telemetry/**"]
  writes: ["src/agents/model-router.ts", "src/config/**", "tests/agents/model-router.test.ts"]
  requirements: ["agent-runtime: Provider abstraction and beta support", "agent-runtime: Honest provider capability reporting"]
  scenarios: ["Required OpenAI provider unavailable", "User selects unavailable Copilot execution"]
  verify: ["bun test tests/agents/model-router.test.ts"]
  manual: null
  ```

- [ ] 8.5 Add capability-detected Serena and Hindsight adapters with lower-authority reads and brokered Serena writes; verify absent adapters do not block core startup and conflicting memory loses.

  ```yaml harness-task
  id: "8.5"
  dependsOn: ["8.2", "7.2"]
  role: builder
  reads: ["src/context/**", "src/tools/**", "src/openspec/**"]
  writes: ["src/integrations/**", "tests/integrations/**"]
  requirements: ["agent-runtime: Optional Serena and Hindsight adapters", "openspec-contract: OpenSpec state precedence"]
  scenarios: ["Optional integrations absent", "Memory conflicts with current specification"]
  verify: ["bun test tests/integrations"]
  manual: null
  ```

## 9. Implement Manual Interaction Checkpoints

- [ ] 9.1 Implement planned/runtime manual-action classification, secret redaction, and atomic checkpoint records for all five mandatory categories; verify interactive and prohibited fixtures stop before action.

  ```yaml harness-task
  id: "9.1"
  dependsOn: ["3.2", "5.2", "7.4"]
  role: builder
  reads: ["src/persistence/**", "src/execution/**", "src/tools/**"]
  writes: ["src/controller/manual-checkpoint.ts", "src/persistence/**", "tests/manual/classifier.test.ts"]
  requirements: ["manual-interaction: Mandatory manual-action categories", "manual-interaction: Planned manual task contract", "manual-interaction: Runtime-discovered manual checkpoint", "manual-interaction: Persisted checkpoint record"]
  scenarios: ["Command requests a password", "Deployment would mutate an external environment", "Planned manual task becomes eligible", "Agent encounters an unexpected login", "Harness restarts while paused"]
  verify: ["bun test tests/manual/classifier.test.ts"]
  manual: null
  ```

- [ ] 9.2 Integrate branch-level pause closure with scheduling and writer revocation while allowing safe independent branches; verify dependents stop and unrelated reads/writes obey normal leases.

  ```yaml harness-task
  id: "9.2"
  dependsOn: ["9.1", "6.4"]
  role: builder
  reads: ["src/controller/manual-checkpoint.ts", "src/execution/**"]
  writes: ["src/execution/scheduler.ts", "src/controller/**", "tests/manual/branch-pause.test.ts"]
  requirements: ["manual-interaction: Affected-branch pause"]
  scenarios: ["Independent branch remains ready"]
  verify: ["bun test tests/manual/branch-pause.test.ts"]
  manual: null
  ```

- [ ] 9.3 Add prominent Pi notification, status rendering, restart restoration, and explicit `/change resume` confirmation with audit metadata; verify unresolved checkpoints never auto-resume.

  ```yaml harness-task
  id: "9.3"
  dependsOn: ["9.2", "4.4"]
  role: builder
  reads: ["src/controller/**", "src/extension/**", "src/persistence/**"]
  writes: ["src/extension/manual-ui.ts", "src/controller/manual-checkpoint.ts", "tests/manual/resume.test.ts"]
  requirements: ["manual-interaction: Pi user notification", "manual-interaction: Explicit confirmation resume"]
  scenarios: ["Manual checkpoint is created", "User confirms completion", "No confirmation arrives"]
  verify: ["bun test tests/manual/resume.test.ts"]
  manual: null
  ```

- [ ] 9.4 Add end-to-end manual-stop tests covering authentication, privilege, destructive Git, external mutation, design choice, restart, and sanitized telemetry; verify no secret reaches persisted files.

  ```yaml harness-task
  id: "9.4"
  dependsOn: ["9.3", "3.3"]
  role: builder
  reads: ["src/controller/**", "src/tools/**", "src/telemetry/**"]
  writes: ["tests/manual/e2e.test.ts", "tests/fixtures/manual/**"]
  requirements: ["manual-interaction: Mandatory manual-action categories", "manual-interaction: Persisted checkpoint record", "telemetry-and-cost: Secret-safe telemetry"]
  scenarios: ["Command requests a password", "Harness restarts while paused", "Authentication checkpoint occurs"]
  verify: ["bun test tests/manual/e2e.test.ts"]
  manual: null
  ```

## 10. Enforce Engineering Policies and Task Completion

- [ ] 10.1 Implement TDD evidence records and reviewed non-applicability exceptions linked to requirements/scenarios; verify behavior tasks cannot complete without red/green/refactor evidence.

  ```yaml harness-task
  id: "10.1"
  dependsOn: ["5.5", "8.2"]
  role: builder
  reads: ["src/execution/**", "src/context/**", "src/persistence/**"]
  writes: ["src/policies/tdd.ts", "src/execution/**", "tests/policies/tdd.test.ts"]
  requirements: ["policy-enforcement: Test-driven implementation policy"]
  scenarios: ["Behavior task has no red-stage evidence"]
  verify: ["bun test tests/policies/tdd.test.ts"]
  manual: null
  ```

- [ ] 10.2 Implement threshold-triggered systematic debugging state and evidence contract; verify repeated failures stop unguided repair and preserve a discriminating hypothesis trail.

  ```yaml harness-task
  id: "10.2"
  dependsOn: ["5.5", "3.2"]
  role: builder
  reads: ["src/execution/**", "src/persistence/**"]
  writes: ["src/policies/debugging.ts", "src/execution/**", "tests/policies/debugging.test.ts"]
  requirements: ["policy-enforcement: Systematic debugging activation"]
  scenarios: ["Repeated repair does not pass"]
  verify: ["bun test tests/policies/debugging.test.ts"]
  manual: null
  ```

- [ ] 10.3 Implement fresh read-only per-task code review over contract, diff, tests, scopes, and TDD evidence; verify blocking findings return the task for repair.

  ```yaml harness-task
  id: "10.3"
  dependsOn: ["4.3", "10.1", "7.6"]
  role: builder
  reads: ["src/review/**", "src/execution/**", "src/policies/**"]
  writes: ["src/review/code-review.ts", "tests/review/code-review.test.ts"]
  requirements: ["review-and-verification: Independent task code review"]
  scenarios: ["Task review fails"]
  verify: ["bun test tests/review/code-review.test.ts"]
  manual: null
  ```

- [ ] 10.4 Assemble the task runner pipeline from fresh builder through TDD, brokered verification, fresh review, evidence persistence, and checkbox update; verify claims cannot bypass any gate.

  ```yaml harness-task
  id: "10.4"
  dependsOn: ["8.3", "9.3", "10.2", "10.3"]
  role: builder
  reads: ["src/agents/**", "src/context/**", "src/execution/**", "src/review/**", "src/policies/**"]
  writes: ["src/execution/task-runner.ts", "tests/execution/task-pipeline.test.ts"]
  requirements: ["task-orchestration: Dependency and gate ordering", "task-orchestration: Durable task completion synchronization", "policy-enforcement: Mandatory gates survive budget pressure"]
  scenarios: ["Focused test failure", "Agent claims completion without evidence", "Budget is exhausted before review"]
  verify: ["bun test tests/execution/task-pipeline.test.ts"]
  manual: null
  ```

- [ ] 10.5 Integrate the task runner with scheduler recovery, worktrees, and design-conflict re-planning; verify crash, retry, conflict, stale review, and resumed-branch flows end to end.

  ```yaml harness-task
  id: "10.5"
  dependsOn: ["10.4", "3.5", "6.4"]
  role: builder
  reads: ["src/execution/**", "src/controller/**", "src/persistence/**", "src/review/**"]
  writes: ["src/execution/**", "src/controller/**", "tests/execution/implementation-flow.test.ts"]
  requirements: ["task-orchestration: Design conflict outcome", "runtime-recovery: Idempotent recovery", "review-and-verification: Deterministic artifact digest"]
  scenarios: ["Repository contradicts approved design", "Crash after source write before task state update", "Reviewed artifact changes"]
  verify: ["bun test tests/execution/implementation-flow.test.ts"]
  manual: null
  ```

## 11. Deliver the Canonical Change Command Surface

- [ ] 11.1 Implement `/change` argument parsing, change resolution, help, prerequisite diagnostics, status rendering, and command dispatch; verify unknown commands and missing prerequisites do not mutate state.

  ```yaml harness-task
  id: "11.1"
  dependsOn: ["4.5", "9.3"]
  role: builder
  reads: ["src/controller/**", "src/extension/**"]
  writes: ["src/extension/change-command.ts", "src/controller/action-resolver.ts", "tests/commands/change-command.test.ts"]
  requirements: ["change-workflows: Canonical change commands", "change-workflows: Prerequisite-directed commands"]
  scenarios: ["Unknown subcommand", "Implement before review"]
  verify: ["bun test tests/commands/change-command.test.ts"]
  manual: null
  ```

- [ ] 11.2 Implement non-durable explore plus propose/refine orchestration with risk-scaled optional opinions and conditional debate; verify explore creates no artifacts unless promoted.

  ```yaml harness-task
  id: "11.2"
  dependsOn: ["11.1", "8.4", "8.5"]
  role: builder
  reads: ["src/controller/**", "src/agents/**", "src/openspec/**", "extensions/fusion-harness/**"]
  writes: ["src/controller/explore.ts", "src/controller/planning.ts", "tests/commands/planning.test.ts"]
  requirements: ["change-workflows: Exploration remains non-durable by default", "change-workflows: Risk-scaled orchestration", "change-workflows: Autonomous safe progression"]
  scenarios: ["Explore an idea", "Localized low-risk task", "Cross-cutting ambiguous change", "Phase has no blockers"]
  verify: ["bun test tests/commands/planning.test.ts"]
  manual: null
  ```

- [ ] 11.3 Implement `/change review` using fresh reviewer dispatch, digest persistence, binary verdicts, and revise loops; verify implementation remains blocked until current approval.

  ```yaml harness-task
  id: "11.3"
  dependsOn: ["11.1", "4.3"]
  role: builder
  reads: ["src/controller/**", "src/review/**", "src/openspec/**"]
  writes: ["src/controller/review.ts", "tests/commands/review.test.ts"]
  requirements: ["review-and-verification: Fresh read-only planning review", "review-and-verification: Binary planning verdict", "change-workflows: Prerequisite-directed commands"]
  scenarios: ["Planning artifacts are ready", "Reviewer identifies required correction", "Implement before review"]
  verify: ["bun test tests/commands/review.test.ts"]
  manual: null
  ```

- [ ] 11.4 Implement `/change implement` and `/change resume` over worktree, scheduler, task pipeline, and branch checkpoints; verify safe phases progress autonomously and paused branches require explicit confirmation.

  ```yaml harness-task
  id: "11.4"
  dependsOn: ["10.5", "11.3"]
  role: builder
  reads: ["src/controller/**", "src/execution/**", "src/extension/**"]
  writes: ["src/controller/implement.ts", "src/extension/change-command.ts", "tests/commands/implement.test.ts"]
  requirements: ["change-workflows: Autonomous safe progression", "manual-interaction: Explicit confirmation resume", "task-orchestration: Controller-owned dedicated worktree"]
  scenarios: ["Phase has no blockers", "User confirms completion", "Implement from the planning checkout"]
  verify: ["bun test tests/commands/implement.test.ts"]
  manual: null
  ```

- [ ] 11.5 Route overlapping `/refine`, `/implement`, and `/ship` behavior through controller safety checks and add deprecation guidance to preserved legacy commands; verify the full imported command suite remains usable.

  ```yaml harness-task
  id: "11.5"
  dependsOn: ["11.2", "11.4"]
  role: builder
  reads: ["extensions/fusion-harness/**", "src/controller/**", "src/extension/**"]
  writes: ["src/extension/**", "extensions/fusion-harness/**", "tests/commands/legacy.test.ts", "README.md"]
  requirements: ["project-foundation: Incremental compatibility migration", "change-workflows: Legacy command transition"]
  scenarios: ["Legacy workflow invocation", "Legacy implement command"]
  verify: ["bun test extensions/fusion-harness/tests", "bun test tests/commands/legacy.test.ts"]
  manual: null
  ```

## 12. Add Final Verification, Finish, and Budget Reporting

- [ ] 12.1 Implement fresh read-only final validation over OpenSpec, tasks, evidence, tests, findings, design, freshness, reports, and Git/worktree state; verify a failing full suite blocks readiness despite builder success.

  ```yaml harness-task
  id: "12.1"
  dependsOn: ["10.5", "11.4"]
  role: builder
  reads: ["src/controller/**", "src/review/**", "src/execution/**", "src/openspec/**"]
  writes: ["src/review/validator.ts", "tests/review/validator.test.ts"]
  requirements: ["review-and-verification: Evidence-based final verification"]
  scenarios: ["Builder reports all work complete"]
  verify: ["bun test tests/review/validator.test.ts"]
  manual: null
  ```

- [ ] 12.2 Implement durable `verification.md` generation with reproducible commands, evidence links, findings, deviations, warnings, and source/artifact digests; verify raw transcripts are excluded.

  ```yaml harness-task
  id: "12.2"
  dependsOn: ["12.1", "3.2"]
  role: builder
  reads: ["src/review/**", "src/persistence/**", "schemas/fusion-driven/**"]
  writes: ["src/review/verification-artifact.ts", "tests/review/verification-artifact.test.ts"]
  requirements: ["review-and-verification: Durable verification summary"]
  scenarios: ["Verification passes"]
  verify: ["bun test tests/review/verification-artifact.test.ts"]
  manual: null
  ```

- [ ] 12.3 Implement `/change verify` and `/change finish` with separate freshness gates; verify success does not commit/archive/merge/push/delete and finish delegates only archive after recheck.

  ```yaml harness-task
  id: "12.3"
  dependsOn: ["12.2", "2.3", "11.1"]
  role: builder
  reads: ["src/controller/**", "src/review/**", "src/openspec/**", "src/execution/**"]
  writes: ["src/controller/verify.ts", "src/controller/finish.ts", "src/extension/change-command.ts", "tests/commands/verify-finish.test.ts"]
  requirements: ["change-workflows: Verification and finish are separate", "review-and-verification: Explicit finish boundary", "openspec-contract: OpenSpec-managed archive"]
  scenarios: ["Verification succeeds", "Source changes after verification", "Finish an accepted change"]
  verify: ["bun test tests/commands/verify-finish.test.ts"]
  manual: null
  ```

- [ ] 12.4 Implement run/phase/role/task budgets, optional fan-out forecasting, and protected mandatory gates; verify budget exhaustion skips debate before blocking required work and never marks incomplete work done.

  ```yaml harness-task
  id: "12.4"
  dependsOn: ["3.3", "4.5", "10.4"]
  role: builder
  reads: ["src/telemetry/**", "src/controller/**", "src/execution/**"]
  writes: ["src/telemetry/budget.ts", "src/controller/**", "tests/telemetry/budget.test.ts"]
  requirements: ["telemetry-and-cost: Enforced hierarchical budgets", "policy-enforcement: Mandatory gates survive budget pressure"]
  scenarios: ["Optional debate exceeds forecast budget", "Budget is exhausted before review"]
  verify: ["bun test tests/telemetry/budget.test.ts"]
  manual: null
  ```

- [ ] 12.5 Add sanitized context categories and compact phase/run summaries with exact-versus-estimated labels and beta claim guards; verify secret fixtures and insufficient comparisons are reported honestly.

  ```yaml harness-task
  id: "12.5"
  dependsOn: ["12.4", "9.4"]
  role: builder
  reads: ["src/telemetry/**", "src/context/**", "src/controller/**"]
  writes: ["src/telemetry/report.ts", "src/telemetry/redaction.ts", "tests/telemetry/report.test.ts"]
  requirements: ["telemetry-and-cost: Context usage categories", "telemetry-and-cost: Compact run summary", "telemetry-and-cost: Secret-safe telemetry", "telemetry-and-cost: Evidence-based optimization claims", "telemetry-and-cost: Optimization does not redefine correctness"]
  scenarios: ["Exact category counts unavailable", "User inspects completed run", "Authentication checkpoint occurs", "Insufficient comparative data", "Mandatory validator is expensive"]
  verify: ["bun test tests/telemetry/report.test.ts"]
  manual: null
  ```

## 13. Complete Cross-Platform Beta Acceptance

- [ ] 13.1 Add fixture-driven end-to-end tests for direct, bounded, and architectural changes from status through verified state, including stale review, design conflict, manual pause, recovery, and explicit finish behavior.

  ```yaml harness-task
  id: "13.1"
  dependsOn: ["11.5", "12.5"]
  role: builder
  reads: ["src/**", "schemas/**", "tests/**"]
  writes: ["tests/e2e/**", "tests/fixtures/projects/**", "package.json"]
  requirements: ["change-workflows: Canonical change commands", "review-and-verification: Evidence-based final verification", "runtime-recovery: Resume supported interruption points"]
  scenarios: ["Unknown subcommand", "Builder reports all work complete", "Restart after passing task review"]
  verify: ["bun test tests/e2e"]
  manual: null
  ```

- [ ] 13.2 Add Linux, macOS, and native Windows CI jobs for Node 22/Bun typecheck, unit/integration tests, extension smoke, Git/worktree semantics, and host-runner contract tests; verify workflow syntax locally and document expected matrix results.

  ```yaml harness-task
  id: "13.2"
  dependsOn: ["13.1", "7.7"]
  role: builder
  reads: ["package.json", "tests/**", "src/**"]
  writes: [".github/workflows/**", "scripts/ci/**", "docs/testing.md", "package.json"]
  requirements: ["project-foundation: Supported runtime baseline", "policy-enforcement: Host command execution controls"]
  scenarios: ["Platform verification matrix", "Host command exceeds its boundary", "User inspects beta isolation"]
  verify: ["bun run ci:validate", "bun run typecheck", "bun test"]
  manual: null
  ```

- [ ] 13.3 Document the beta host-execution trust boundary and create a non-blocking post-beta hardening backlog for OCI or native process/network isolation behind the command-runner interface; verify status, help, and security docs do not claim sandboxing.

  ```yaml harness-task
  id: "13.3"
  dependsOn: ["13.2"]
  role: builder
  reads: ["src/tools/**", "README.md", "docs/**"]
  writes: ["README.md", "docs/security.md", "docs/roadmap.md"]
  requirements: ["policy-enforcement: Host command execution controls", "project-foundation: Correctness-ready beta labeling"]
  scenarios: ["User inspects beta isolation", "Version and help output"]
  verify: ["bun run docs:check", "bun test tests/tools/command-profile.test.ts"]
  manual: null
  ```

- [ ] 13.4 **MANUAL STOP (conditional):** If cross-platform CI requires a push, hosted-runner authorization, or runner enrollment, notify in Pi and stop this acceptance branch; the user reviews and triggers the workflow externally, waits for Linux/macOS/Windows completion, then explicitly resumes.

  ```yaml harness-task
  id: "13.4"
  dependsOn: ["13.2"]
  role: manual
  reads: [".github/workflows/**", "docs/testing.md"]
  writes: []
  requirements: ["project-foundation: Supported runtime baseline", "manual-interaction: Mandatory manual-action categories", "manual-interaction: Persisted checkpoint record"]
  scenarios: ["Platform verification matrix", "Deployment would mutate an external environment", "Harness restarts while paused"]
  verify: ["bun run acceptance:ci-status"]
  manual:
    category: external_side_effect
    condition: "The required platform matrix cannot run locally and needs a remote push, workflow dispatch, authorization, or runner enrollment."
    reason: "Agents may not push code, authorize hosted execution, or enroll external runners autonomously."
    instructions:
      - "Review the branch and CI workflow locally."
      - "Trigger the Linux/macOS/Windows matrix through your approved remote workflow without sharing credentials in agent chat."
      - "Wait for all required jobs to finish, then run `/change resume build-openspec-multi-agent-harness <checkpoint-id>`."
    expectedOutcome: "The required Linux, macOS, and native Windows jobs have completed successfully."
    resumeTarget: "13.4"
  ```

- [ ] 13.5 **MANUAL STOP (conditional):** If no authenticated OpenAI model is available, notify in Pi and stop the provider-smoke branch; the user configures OpenAI authentication directly through Pi or their terminal, runs `bun run doctor -- --provider openai`, and explicitly resumes without exposing credentials.

  ```yaml harness-task
  id: "13.5"
  dependsOn: ["8.4", "13.2"]
  role: manual
  reads: ["src/agents/model-router.ts", "src/config/**"]
  writes: []
  requirements: ["agent-runtime: Provider abstraction and beta support", "manual-interaction: Mandatory manual-action categories", "manual-interaction: Explicit confirmation resume"]
  scenarios: ["Required OpenAI provider unavailable", "Command requests a password", "User confirms completion"]
  verify: ["bun run doctor -- --provider openai"]
  manual:
    category: authentication
    condition: "Provider validation cannot resolve and authenticate an OpenAI model."
    reason: "Agents and model-visible tools must never request, receive, or persist the user's API key or login secret."
    instructions:
      - "Configure OpenAI authentication using Pi's direct credential flow or your own terminal outside agent chat."
      - "Run `bun run doctor -- --provider openai` until it reports an authenticated model."
      - "Run `/change resume build-openspec-multi-agent-harness <checkpoint-id>`; never paste the credential into the conversation."
    expectedOutcome: "The provider doctor exits successfully with at least one authenticated OpenAI model."
    resumeTarget: "13.5"
  ```

- [ ] 13.6 Run the live OpenAI, fresh-review, broker/tool-boundary, host-runner, and verification smoke workflow after conditional checkpoints resolve; verify one bounded fixture change reaches `VERIFIED` without commit or archive and emits sanitized usage evidence.

  ```yaml harness-task
  id: "13.6"
  dependsOn: ["13.3", "13.4", "13.5"]
  role: validator
  reads: ["src/**", "schemas/**", "tests/fixtures/projects/**", ".fusion/runs/**"]
  writes: ["tests/acceptance/**", "docs/testing.md"]
  requirements: ["agent-runtime: Provider abstraction and beta support", "review-and-verification: Explicit finish boundary", "telemetry-and-cost: Secret-safe telemetry"]
  scenarios: ["Required OpenAI provider unavailable", "Source changes after verification", "Authentication checkpoint occurs"]
  verify: ["bun run acceptance:live"]
  manual: null
  ```

- [ ] 13.7 Complete beta documentation for installation, doctor output, configuration, task metadata, commands, recovery, manual checkpoints, security model, legacy migration, provider limits, and unverified cost hypothesis; verify examples and links with `bun run docs:check`.

  ```yaml harness-task
  id: "13.7"
  dependsOn: ["13.6"]
  role: builder
  reads: ["src/**", "schemas/**", "tests/**", "README.md"]
  writes: ["README.md", "docs/**", ".env.example", "package.json"]
  requirements: ["project-foundation: Correctness-ready beta labeling", "agent-runtime: Honest provider capability reporting", "telemetry-and-cost: Evidence-based optimization claims"]
  scenarios: ["Version and help output", "User selects unavailable Copilot execution", "Insufficient comparative data"]
  verify: ["bun run docs:check", "bun run typecheck", "bun test"]
  manual: null
  ```