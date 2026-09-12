## Context

See `proposal.md` for motivation and scope. The implementation starts from Fusion Harness commit `51f1d85499a1292cb79036d6ae237db7ea52096e`, whose useful boundaries already include Pi command registration, model-stack resolution, clean-room child spawning, collaboration DAG validation, a lockfile writer lease, prompt contracts, OpenSpec workflow commands, and per-run token summaries.

The imported baseline also constrains the migration:

- it is a Node ESM TypeScript extension tested with Bun;
- provider resolution is delegated to Pi's model registry;
- GitHub Copilot is not a spawnable Pi provider;
- role sessions can currently persist across work and must become fresh by default;
- runtime artifacts currently live under temporary directories and do not support durable recovery;
- OpenSpec payloads are parsed as untyped JSON and some operations use human-oriented CLI forms;
- worktrees are currently prohibited and all writers share `ctx.cwd`;
- the writer lease is process-aware but scoped to the checkout rather than a durable run/worktree identity;
- child Pi processes receive direct built-in tools, so prompt restrictions alone cannot provide the required tool and repository-path boundary.

The capability specs in `specs/**/spec.md` are the normative behavior. This design defines how to reach that behavior while preserving a working extension at each migration stage.

## Goals / Non-Goals

**Goals:**

- Preserve proven Fusion primitives behind stable interfaces while changing their lifecycle and safety semantics incrementally.
- Make every workflow decision derivable from validated OpenSpec, Git, worktree, review, task, and run state.
- Enforce writer, path, tool, command-policy, and manual-action boundaries outside model prompts.
- Keep fresh-agent context small, explicit, reproducible, and measurable.
- Support deterministic recovery and cross-platform beta verification.
- Give users an explicit, durable stop/resume contract whenever automation cannot safely continue.

**Non-Goals:**

- Forking, embedding, installing, or reimplementing OpenSpec.
- Implementing a GitHub Copilot execution adapter in the beta.
- Automatically committing, merging, pushing, publishing, deploying, archiving, or deleting worktrees after verification.
- Preserving Fusion's source layout, persistent builder sessions, no-worktree rule, or untyped OpenSpec client as permanent APIs.
- Treating runtime DAGs, transcripts, Hindsight, Serena, or telemetry as durable project intent.
- Proving the 25-50% token-reduction hypothesis before sufficient comparative runs exist.

## Decisions

### 1. Import a pinned source snapshot, then migrate in place

Copy the Fusion snapshot into muster without its Git history. Add its required MIT notice to `THIRD_PARTY_NOTICES.md`, retain muster's existing project license, and record the source commit in repository documentation. Do not add attribution headers to individual source files.

The first import commit-equivalent state must pass Fusion's existing tests unchanged. Those tests become characterization coverage before modules move. Subsequent stages introduce the target layout:

```text
src/
├── extension/
├── controller/
├── openspec/
├── agents/
├── context/
├── execution/
├── tools/
├── review/
├── policies/
├── persistence/
├── integrations/
└── telemetry/
```

Compatibility re-exports may temporarily preserve imported module paths. Move behavior only after a focused test protects it.

**Alternative considered:** Git subtree import. Rejected because the user does not want imported history and muster becomes the canonical source.

**Alternative considered:** clean-room rewrite. Rejected because it discards tested child-runner, routing, rendering, DAG, and writer-lease behavior without reducing product scope.

### 2. Use a controller-owned state machine

One development controller owns command resolution and legal transitions. Models may recommend outcomes but cannot mutate lifecycle state directly.

```text
EXPLORE
  -> PLANNING
  -> REVIEW_REQUIRED
  -> READY
  -> IMPLEMENTING
  -> VERIFYING
  -> VERIFIED
  -> FINISHING
  -> COMPLETE
```

`AWAITING_USER`, `DESIGN_CONFLICT`, `BLOCKED`, `FAILED`, and `CANCELLED` are explicit side states. `AWAITING_USER` is recorded per task/DAG branch, so unrelated branches can remain schedulable. Any reviewed-artifact change moves the change back to `REVIEW_REQUIRED`. Any relevant post-verification change invalidates `VERIFIED`.

The controller derives state from a `ChangeSnapshot` containing validated OpenSpec status, review digest/verdict, Git and worktree identity, parsed tasks, persisted run state, and current evidence. The snapshot records source timestamps/digests so a command cannot unknowingly act on mixed-time observations.

**Alternative considered:** command-local orchestration. Rejected because legacy commands currently duplicate prerequisite and state logic, making freshness and recovery inconsistent.

### 3. Treat OpenSpec as an external typed protocol

The adapter launches the installed `openspec` executable with argument arrays, bounded timeouts, explicit working directories, and captured stdout/stderr. It performs a startup capability handshake for the JSON forms needed by context, status, instructions, apply instructions, validation, and archive. Zod schemas validate each accepted payload and produce field-level diagnostics.

Version strings are recorded for support but do not decide compatibility alone. Human-oriented output is never parsed when a machine contract is required. Archive remains an adapter call; no harness module merges delta specs or moves archive directories.

The repository adds a `fusion-driven` OpenSpec schema with:

```text
proposal -> specs ----\
       \-> design -----+-> tasks -> review -> verification

apply requires: review
task tracking: tasks.md
```

Review approval is an additional harness gate because OpenSpec tracks artifact existence, not the semantic `APPROVE` verdict or digest freshness.

**Alternative considered:** pin one OpenSpec version. Rejected because capability detection better tolerates compatible releases while still failing closed on contract changes.

### 4. Parse tasks structurally, not with line-oriented regular expressions

Use a Markdown AST and the existing YAML parser. Each executable checkbox must be immediately associated with one fenced `yaml harness-task` block:

````markdown
- [ ] 3.2 Implement typed status parsing

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/openspec/**", "openspec/**"]
  writes: ["src/openspec/**", "tests/openspec/**"]
  requirements: ["openspec-contract: Typed structured responses"]
  scenarios: ["Malformed OpenSpec JSON"]
  verify:
    - "bun test tests/openspec"
  manual: null
  ```
````

For a planned manual action, `manual` contains `category`, `reason`, `instructions`, `expectedOutcome`, and `resumeTarget`; it never contains a secret or asks the user to send one through Pi. The compiler normalizes paths, validates identifiers and references, rejects cycles and scope overlap errors, and emits an immutable DAG snapshot tied to the tasks digest.

Task metadata remains part of OpenSpec because dependencies, scopes, acceptance links, and known human obligations are part of the implementation contract. Runtime state such as attempts, assignments, and timestamps remains under `.fusion/runs`.

**Alternative considered:** separate permanent DAG manifest. Rejected because it would become a second task plan and could drift from OpenSpec.

### 5. Separate model execution from brokered tools

Pi child processes remain the model/agent host, but they no longer receive unrestricted built-in mutation or shell tools. A small child-side broker extension exposes role-specific tools and forwards structured requests to the trusted parent controller. The parent checks run identity, task state, writer ownership, normalized path, declared scope, and operation policy before execution.

Tool classes are:

- read/search tools constrained to declared readable roots;
- patch/write tools constrained to the dedicated worktree, declared write paths, and active writer lease;
- command/test tools executed by the host command runner with an explicit executable/argument contract, cwd, environment allowlist, timeout, output limit, and cancellation policy;
- OpenSpec tools available only to controller-owned workflows or artifact-writer roles;
- integration tools wrapped by the same authorization decision.

Reviewer and validator roles receive no mutation tools. Child tool requests and authorization decisions receive correlation IDs and audit events.

**Alternative considered:** prompt restrictions plus post-run diff auditing. Rejected because prohibited writes and side effects could already have occurred before audit.

### 6. Use a brokered host command runner and defer process isolation

The beta does not require Docker, Podman, or another operating-system sandbox. The host Pi child performs model calls but has only brokered tools; it receives no generic built-in shell or mutation tool. Agent-requested commands execute through a trusted parent runner with:

- structured executable and argument requests with `shell: false` by default;
- an exact working directory inside the recorded change worktree;
- command profiles and executable allowlists selected by task and role;
- a minimal environment allowlist that excludes credentials by default;
- timeout, output-size, cancellation, and child-process cleanup controls;
- preflight classification of authentication, elevation, destructive operations, and external side effects;
- Git state capture before and after execution;
- rejection and audit of out-of-scope repository changes before task evidence is accepted.

Project-defined verification commands may use an explicitly configured shell profile because they are durable reviewed OpenSpec input, not free-form child output. Commands that require credentials, privileged setup, destructive behavior, or external mutation become manual checkpoints before execution.

These controls reduce accidental and agent-directed misuse but do not contain arbitrary host processes. They cannot guarantee filesystem isolation outside the repository or network isolation. Status, help, and security documentation must state this limitation, and the beta must not call host command execution sandboxed.

OCI or native operating-system isolation remains a post-beta hardening milestone behind the same command-runner interface. It can later add containment without changing role, broker, task, or evidence contracts.

**Alternative considered:** require OCI isolation in beta. Deferred at the user's request to remove the installation and cross-platform runtime prerequisite while preserving an adapter boundary for later hardening.

**Alternative considered:** give child agents a direct host shell. Rejected because it would bypass authorization, command classification, audit correlation, environment controls, and manual checkpoints.

### 7. Make the controller the only worktree owner

The worktree manager uses Git plumbing to resolve the repository common directory, current branch, dirty state, existing worktrees, and a deterministic sibling worktree root. It creates one branch/worktree per change unless a matching recorded worktree is safely reusable. Planning remains in the user's current checkout; implementation and verification use the change worktree.

Child tools cannot invoke `git worktree` operations. Verification leaves the worktree intact. `/change finish` rechecks verified source/artifact digests and invokes OpenSpec archive, but still does not merge, push, publish, deploy, or delete the worktree.

The writer lease key includes repository identity and canonical worktree identity. Lease records include owner process, run, task, command, and timestamps. Stale lease recovery requires proving the recorded process is dead and reconciling the worktree before release.

**Alternative considered:** preserve shared-`cwd` execution. Rejected because it weakens isolation, recovery, and the user's ability to inspect or abandon a change independently.

### 8. Compile dependency-ready tasks into fresh role runs

The scheduler maintains explicit task states and dispatches only dependency-ready work. Read-only runs may overlap. A write task must acquire the global worktree writer lease before receiving mutation capability. Dependents wait for implementation, focused verification, task review, and persisted evidence.

Roles are configurations, not conversations:

- architect: phase-scoped and read-only except selected OpenSpec artifact writes through the broker;
- builder: fresh per task with one task capsule;
- reviewer: fresh, read-only, and isolated from author sessions;
- validator: fresh, read-only, and evidence-driven.

A structured builder result is one of `completed`, `blocked`, `awaiting_user`, or `design_conflict`. A design conflict invalidates affected planning review after the architect updates artifacts. Failed expected red-stage tests are evidence; unexpected persistent failures transition into the debugging policy.

### 9. Route models by capability and cost without vendor coupling

Retain Fusion's model-stack YAML and Pi model registry integration behind a `ModelRouter`. Routing filters by role capability, availability, authentication, context size, tool support, and budget. OpenAI availability is a beta acceptance requirement. Existing compatible Pi providers continue to work.

GitHub Copilot is represented as an unavailable provider capability unless a future VS Code adapter is installed. No placeholder may claim to execute Copilot. The future adapter must satisfy the same role, usage, cancellation, and tool-broker interfaces.

Optional Serena and Hindsight adapters expose capabilities only after detection. Serena reads feed code-context selection; Serena writes pass through the broker and lease. Hindsight contributes low-authority preferences and pitfalls only.

### 10. Build task capsules from explicit context tiers

The context assembler indexes OpenSpec artifact sections, task links, dependency reports, repository symbols/files, and project rules. It builds a capsule in this order:

1. required task, permissions, requirements, scenarios, decisions, acceptance, and budget;
2. relevant code and dependency evidence;
3. references to retrievable available material;
4. explicit exclusions for known irrelevant context.

Budget reduction removes duplicate, optional, and referenceable text first. An agent can request more context through a brokered request containing its reason and target. The assembler authorizes and accounts for the additional slice.

Decision capsules and dependency reports replace transcript forwarding. Raw transcripts may be retained temporarily for diagnostics only under configured retention and never become OpenSpec artifacts.

### 11. Make review and verification digest-driven

The artifact digest hashes a canonical stream of sorted repository-relative POSIX paths, byte lengths, and raw file bytes for `proposal.md`, `design.md`, `tasks.md`, and every delta spec. This prevents path/order ambiguity. `review.md` records schema version, round, timestamp, model identity, digest, `APPROVE|REVISE`, critical findings, required changes, and recommendations.

Any required change yields `REVISE`; there is no `APPROVE_WITH_CHANGES`. Before each implementation dispatch, the controller compares the current digest with the latest approval.

Task review uses the task contract, diff, tests, and evidence. Final verification independently runs OpenSpec validation, task checks, required focused/full commands, spec-evidence checks, review-resolution checks, freshness checks, and repository-state checks. `verification.md` stores durable summaries and digests, not model transcripts.

### 12. Persist state as versioned atomic records

Store runtime data under `.fusion/runs/<run-id>/` and ignore it by default. The manifest is a schema-versioned snapshot backed by immutable task results, review results, validation results, usage records, and checkpoint records. Writes use temporary files, flush, and atomic rename through a platform-tested persistence adapter. Recovery rejects unsupported schema versions and corrupt records.

Before retrying work, recovery reconciles:

- current OpenSpec task and artifact digests;
- Git HEAD, index, and worktree diff;
- accepted task result/review evidence;
- child process and writer lease identity;
- unresolved manual checkpoints.

If source changed but completion state did not, recovery routes the existing diff through tests/review rather than rerunning a builder. If reconciliation is ambiguous, it fails closed and reports the evidence the user must inspect.

### 13. Treat manual interaction as a durable branch state

The broker and command runner classify planned metadata and runtime events into `authentication`, `elevated_permission`, `destructive`, `external_side_effect`, or `design_decision`. Before executing the triggering operation, they atomically write an `awaiting_user` checkpoint and revoke the affected task's capabilities.

Pi receives a visible notification with sanitized instructions and the exact `/change resume <change> <checkpoint-id>` command. Independent DAG branches may continue, but the paused task and all dependents remain blocked. Restarts restore the notification and state.

Resume requires explicit user confirmation only, as requested. It records confirmation metadata and returns to the recorded state; it does not ask the user or an agent to expose secret values and does not automatically inspect secret material. A later gate may still fail if the manual action did not achieve its expected outcome.

### 14. Encode engineering discipline as gates plus compact policies

Keep role prompts short and put deterministic checks in code:

- TDD evidence links a requirement/scenario to red, green, and post-refactor commands, with explicit reviewed exceptions;
- repeated unexpected failures activate a structured debugging state;
- task completion requires focused tests and fresh review;
- final completion requires independent verification;
- budgets may reduce optional opinions/debate but never mandatory gates;
- all path, writer, tool, command-policy, digest, and state checks are runtime decisions.

Policies explain judgment expectations but cannot grant permissions or mark gates passed.

### 15. Record telemetry without recording secrets or overstating precision

Usage records preserve provider-reported token and cost fields separately. Context-category attribution is exact only when measurable and otherwise labeled estimated. Hierarchical budgets apply at run, phase, role, and task levels. Optional fan-out is forecast before dispatch.

The run summary distinguishes mandatory from optional cost and reports skipped work, retries, and unknown costs. Prompt bodies, unrestricted tool output, environment secrets, and checkpoint credentials are excluded by default.

The beta records comparable measurements but labels the 25-50% saving as a hypothesis. A later benchmark change can define representative workloads and statistical release gates after enough real traces exist.

## Risks / Trade-offs

- **Host command execution is not containment** -> Remove generic child shell access, allow only brokered command profiles, minimize environment exposure, classify prohibited actions before execution, audit repository changes afterward, and display the limitation prominently.
- **Host process and path semantics differ across Linux, macOS, and Windows** -> Use argument-array spawning, normalize paths at the broker boundary, and run path, symlink, case-sensitivity, cancellation, process-cleanup, and output-limit tests on all three platforms.
- **Removing direct Pi tools may break imported workflows** -> Introduce the broker behind compatibility adapters and migrate one command family at a time under characterization tests.
- **Structured metadata makes `tasks.md` longer** -> Generate and validate a documented template, keep runtime-only fields out of OpenSpec, and provide errors tied to task identifiers and YAML fields.
- **User-confirmation-only resume can resume before a manual action is actually complete** -> Preserve the user's requested authority model, then let the next deterministic prerequisite or verification command fail normally with a clear diagnostic.
- **Allowing independent branches during a manual pause increases state complexity** -> Persist branch-level dependency closure and continue to serialize all source writes through one lease.
- **A host model process and approved commands may access the network** -> Remove generic child shell/write tools, strip credentials by default, classify external side effects before execution, and route all agent-directed commands through the authenticated broker; defer network containment.
- **OpenSpec JSON contracts may evolve** -> Isolate schemas in the adapter, test recorded compatible/incompatible fixtures, and make capability handshake failures actionable.
- **Fresh contexts can omit critical information** -> Treat requirements, scenarios, permissions, acceptance, and dependency interfaces as non-truncatable; support audited context escalation.
- **Legacy commands can prolong duplicate code paths** -> Route overlapping commands through controller services and publish a removal criterion rather than a date-only promise.
- **Runtime recovery can misclassify external edits** -> Compare content and Git state, never trust timestamps alone, and fail closed when ownership is ambiguous.
- **Native Windows support expands the beta matrix** -> Make Windows path/process/cancellation and cleanup tests release-blocking and use the same structured host-runner contract on every platform.

## Migration Plan

1. Import the pinned Fusion source and assets, add `THIRD_PARTY_NOTICES.md`, establish Node 22/Bun/TypeScript configuration, and preserve all baseline tests.
2. Add cross-platform CI and characterization tests before changing orchestration behavior.
3. Introduce shared domain types, structured errors, and typed OpenSpec adapter/capability handshake while preserving existing commands.
4. Add the `fusion-driven` schema and stop any remaining duplicate durable planning output.
5. Introduce versioned run persistence and telemetry around existing execution without changing scheduling.
6. Add deterministic artifact digests, binary planning review, and freshness gates.
7. Introduce the controller state machine and route `/change status`, review, and legacy workflow prerequisites through it.
8. Add controller-owned worktrees and migrate writer-lease identity to repository/worktree/run scope.
9. Introduce the child tool broker and constrained host command runner, then migrate read-only roles before write-enabled builders.
10. Replace persistent role sessions with fresh architects, builders, reviewers, and validators plus task capsules.
11. Replace line-based tasks with Markdown/YAML parsing, compile the runtime DAG, and add branch-level manual checkpoints.
12. Add task review, TDD/debugging gates, final verification, explicit finish, and all `/change` commands.
13. Add optional Serena/Hindsight adapters and deprecation guidance for overlapping legacy commands.
14. Run the Linux/macOS/Windows release matrix, recovery fault injection, tool/path/command-policy tests, OpenAI live smoke test, and beta documentation review.
15. Release only as a correctness-ready beta; accumulate telemetry for a later comparative optimization gate.

Rollback is stage-local. Keep imported command behavior behind compatibility adapters until each replacement passes characterization and integration tests. A failed stage reverts its routing/configuration to the last tested service boundary without deleting OpenSpec artifacts or user worktrees. Persistence migrations must be additive during beta; unsupported newer state fails with a diagnostic rather than being downgraded destructively.

Manual prerequisites are deliberate stop points, not agent tasks to improvise:

- If Bun, Git, OpenSpec, or Pi requires privileged/system installation, persist `awaiting_user`, notify in Pi, and wait for explicit resume.
- If OpenAI authentication is absent for the live beta smoke test, instruct the user to configure it directly in Pi or their terminal; never request the credential through an agent conversation.
- If CI runner enrollment, signing, publishing, deployment, or another external mutation is desired, create an external-side-effect checkpoint. These actions are not implied by successful verification.

## Open Questions

None. OCI/process isolation, GitHub Copilot execution, and statistically gated cost claims are explicitly deferred capabilities, not unresolved beta decisions.