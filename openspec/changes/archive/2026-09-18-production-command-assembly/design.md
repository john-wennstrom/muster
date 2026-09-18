## Context

See `proposal.md` for motivation. The repository already contains phase controllers, typed OpenSpec and Git adapters, atomic run storage, model routing, brokered children, scheduler and writer-lease enforcement, review/verification artifacts, and a `/change` dispatcher. Those pieces are tested in isolation, but `createProductionChangeCommandDependencies()` currently captures `process.cwd()`, wires only `explore`, and leaves every mutating phase unassembled. The dispatcher resolves and persists a change before it knows whether the action is read-only or allowed.

This change must preserve the existing controller gates. The legacy Fusion commands are compatibility surfaces and cannot stand in for production `/change` execution. P0.2 presentation work and the broader P0.3 snapshot/freshness redesign remain separate roadmap items, though this design introduces the output and context seams they will use.

## Goals / Non-Goals

**Goals:**

- Give every advertised action a real default handler assembled from existing production boundaries.
- Bind all phase work to one invocation-scoped identity and cancellation lifetime.
- Make path and change resolution deterministic and safe before side effects.
- Make read-only actions side-effect free and exploration independent of change health.
- Return persistent, testable outcomes with exact blocker guidance.
- Test the same default dependency construction shipped by `registerMuster()`.

**Non-Goals:**

- Replacing controller logic with a second orchestration engine.
- Reusing legacy `/implement`, `/refine`, or `/ship` execution to satisfy missing handlers.
- Building the Fusion-style live multi-column presentation tracked by P0.2.
- Completing all artifact discovery and source-digest improvements tracked by P0.3.
- Changing OpenSpec archive semantics, automatically committing, merging, pushing, or deleting worktrees.

## Decisions

### 1. Build an immutable command-run context per invocation

`registerChangeCommand` will ask a production runtime factory to create a `CommandRunContext` from the host invocation rather than receiving a dependency object permanently bound to extension startup. The context will carry:

```ts
interface CommandRunContext {
  action: ChangeAction;
  repositoryCwd: string;
  planningHome: string;
  change?: ResolvedChange;
  worktree?: ResolvedWorktree;
  runId?: string;
  models: ResolvedRoleModels;
  signal: AbortSignal;
  output: CommandOutputSink;
}
```

The factory resolves repository and OpenSpec identity once, then constructs adapters, stores, brokers, children, and controllers from these values. A phase may derive a worktree or run ID later, but it returns a new context value rather than mutating shared extension state. Tests can replace external process and model ports at the factory boundary while retaining the real production handler map.

Alternative considered: continue capturing `process.cwd()` in the production dependency factory. Rejected because one Pi process may invoke commands for multiple repositories and because it makes host-context tests unable to prove path isolation.

### 2. Separate lookup, validation, and active-change persistence

Change resolution becomes action-aware and returns a structured `ResolvedChange` containing the canonical slug, planning home, change root, and resolved artifact paths. Validation occurs in this order:

1. reject empty, absolute, separated, dot-segment, and non-canonical slugs;
2. obtain the planning home and change location from typed OpenSpec status/discovery data;
3. confirm every resolved path remains inside the canonical changes directory;
4. enumerate case/normalization-equivalent directory names and reject collisions;
5. require existence for every action except creation through `propose`;
6. load and evaluate prerequisites;
7. persist the active change only when an allowed mutating phase begins.

Status performs steps 1-5 without step 7. Explore performs none of them unless a future explicit option supplies scoped change context.

Alternative considered: sanitize a supplied string and join it to `cwd/openspec/changes`. Rejected because sanitization can silently select a different directory and bypasses OpenSpec's resolved planning home.

### 3. Make dispatch phase ordering explicit

The dispatcher will follow four paths:

- `explore`: validate prompt, build a repository-only context, and dispatch immediately;
- `status`: resolve a read-only change, load a snapshot, and render status;
- `propose`: validate a new or existing canonical slug according to proposal semantics, then dispatch planning;
- all remaining phases: resolve an existing change, load its snapshot, evaluate prerequisites, then dispatch.

Resolution returns typed blocker details instead of a preformatted generic reason. Rendering maps each blocker to the exact artifact, digest, model capability, checkpoint, or next command. Handler absence for an advertised action becomes a startup/configuration failure rather than a user-facing availability branch.

Alternative considered: preserve the current single dispatch path and special-case more actions after snapshot loading. Rejected because it cannot guarantee that exploration is independent or that status remains read-only.

### 4. Assemble phase handlers around existing controllers

The production handler map will be complete and created in one module:

- `propose` and `refine` call the planning controller with deterministic complexity input, configured architect/specialist models, brokered read access, OpenSpec instructions, and artifact-writer output constrained to the resolved change root.
- `review` calls the planning-review controller with the canonical artifact set, fresh reviewer session, current author model, eligible configured candidates, and brokered read-only runner.
- `implement` loads apply instructions, compiles the structured task DAG, selects the controller-owned worktree, reconstructs or creates the run manifest, plans recovery, and calls the implementation controller with brokered task execution, writer lease, policy, evidence, and persistence dependencies.
- `resume` validates and confirms exactly one pending checkpoint, creates the same implementation flow as `implement`, and calls the resume controller. It never treats a resume token as free-form input.
- `verify` builds all final-validation collectors from OpenSpec, task evidence, tests, findings, design, freshness, reports, Git/worktree state, and persisted records, then calls the verification controller.
- `finish` recomputes current artifact/source digests and calls the finish controller, whose only final side effect is typed `OpenSpecAdapter.archive()`.

Each assembler is a small named function returning the controller's existing input/dependency types. This keeps production choices reviewable and prevents a monolithic handler from duplicating controller logic.

Alternative considered: route `/change` handlers into legacy Fusion commands. Rejected because those paths do not enforce the new digest, DAG, checkpoint, and verification gates consistently.

### 5. Use typed outcomes and one persistent output sink

Handlers return `CommandOutcome` rather than writing arbitrary notifications:

```ts
type CommandOutcome =
  | { status: "success"; action: ChangeAction; change?: string; runId?: string; summary: string; next?: string }
  | { status: "blocked"; action: ChangeAction; change?: string; runId?: string; reason: CommandBlocker; next: string }
  | { status: "cancelled"; action: ChangeAction; change?: string; runId?: string; summary: string }
  | { status: "failure"; action: ChangeAction; change?: string; runId?: string; code: string; summary: string };
```

The dispatcher serializes exactly one terminal outcome through a persistent transcript sink. The runtime may also update transient UI while work is active. Known controller and adapter errors map to structured blockers or bounded failures; unknown errors retain a stable code and safe message. Run-backed phases persist the same terminal state in the atomic run store.

Alternative considered: let each handler call `ui.notify`. Rejected because notifications are transient, inconsistent, and difficult to assert as one terminal result.

### 6. Resolve models and cancellation once, then pass them through

The runtime resolves the configured model stack at invocation start and derives explicit role assignments used by every child request and persisted manifest. Mandatory routing failure happens before any child starts. One abort signal flows into OpenSpec processes, brokered children, host commands, scheduler work, and cleanup. Every handler owns resources in `try/finally`, releases live resources, and converts abort into `cancelled` rather than a generic failure.

Alternative considered: resolve models independently inside each child helper. Rejected because it can produce inconsistent assignments within one run and cannot give an early, exact unavailable-model diagnostic.

### 7. Prove default wiring with controlled ports, not injected handlers

Acceptance tests register the extension without passing a `ChangeCommandDependencies` handler map. A production-runtime options object may replace only external ports such as OpenSpec process execution, model execution, Git process execution, clock/UUID, and output capture. Tests invoke the registered command callbacks for every advertised action and assert a persistent terminal outcome, correct controller evidence, path isolation, and no missing-handler fallback.

Unit tests remain for validation and outcome mapping. A fixture repository provides valid and blocked lifecycle states so expensive model execution is deterministic while the assembled production path remains real.

## Risks / Trade-offs

- **The existing controller interfaces require many dependencies and may expose missing lower-level production behavior** → Add phase assemblers incrementally and fail with a precise typed blocker; do not weaken gates to make the path pass.
- **Invocation context refactoring can disturb injected tests and legacy command integration** → Keep a compatibility adapter for existing tests during migration, then make default registration use the new factory and add shared-controller assertions for legacy aliases.
- **Filesystem case and normalization differ across platforms** → Compare canonical directory entries using an explicit normalization key and test native Windows plus case-sensitive fixtures where available.
- **A terminal outcome could be emitted twice when cleanup also fails** → Centralize terminal serialization in the dispatcher and attach cleanup failures to the primary outcome rather than emitting separately.
- **P0.1 intersects later snapshot and UI work** → Introduce stable context/output interfaces now and keep artifact collection and presentation implementations replaceable.

## Migration Plan

1. Add context, resolution, blocker, and outcome types while adapting the existing explore/status behavior.
2. Change default registration to construct invocation-scoped runtimes; retain an explicit compatibility path for unit-test dependency injection.
3. Add phase assemblers in lifecycle order: planning, review, implementation/resume, verification, finish.
4. Add default-registration acceptance fixtures and require every advertised action to terminate persistently.
5. Remove the missing-handler branch for advertised actions once the acceptance sweep passes; retain unknown-command usage behavior.

Rollback consists of reverting default registration to the prior dependency adapter. Persisted records remain schema-compatible because phase controllers and stores are reused rather than replaced.
