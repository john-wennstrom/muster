## Purpose

Defines how Muster turns every advertised `/change` action into a validated, invocation-scoped production workflow with actionable and persistent results.

## ADDED Requirements

### Requirement: Complete production command surface
The default extension registration SHALL provide production handlers for `explore`, `propose`, `refine`, `review`, `implement`, `verify`, `finish`, `status`, and `resume`. Each phase handler SHALL invoke its intended production controller and SHALL preserve that controller's OpenSpec, review, permission, writer, checkpoint, and verification gates.

#### Scenario: Advertised phase is invoked
- **WHEN** a user invokes any advertised `/change` phase through the default extension registration
- **THEN** the dispatcher reaches that phase's production handler and does not return a missing-handler or legacy-command fallback

#### Scenario: Production prerequisite blocks a phase
- **WHEN** the intended controller rejects a phase because a mandatory gate is unsatisfied
- **THEN** no later phase or legacy workflow is substituted and the invocation reports a blocked outcome

### Requirement: Invocation-scoped runtime context
Each command invocation SHALL use one immutable runtime context containing the invoking repository working directory, resolved OpenSpec planning home, validated change identity when applicable, selected worktree, run identity, resolved role models, cancellation signal, and persistent output sink. Filesystem, OpenSpec, Git, persistence, child, and controller dependencies SHALL be created from that context rather than process-global working-directory state.

#### Scenario: Host invokes a command from a non-process working directory
- **WHEN** the host command context identifies repository B while the extension process started in repository A
- **THEN** all paths, OpenSpec calls, Git operations, state records, and child working directories for the invocation resolve under repository B

#### Scenario: Command is cancelled
- **WHEN** the invocation cancellation signal is triggered
- **THEN** in-flight OpenSpec, child, scheduler, and host-command work receives cancellation and the command reports a cancelled outcome

### Requirement: Safe change identity resolution
The command runtime SHALL validate explicit and remembered change identifiers and their resolved artifact paths before reading change files, launching a process, or persisting active-change state. Accepted identifiers SHALL be canonical slugs resolving to exactly one change directory inside the OpenSpec planning home's change root.

#### Scenario: Traversal or absolute identifier
- **WHEN** a user supplies an absolute path or an identifier containing path traversal or separators
- **THEN** the command performs no change filesystem read, launches no controller or child, preserves the current active change, and reports the invalid identifier

#### Scenario: Invalid slug
- **WHEN** a user supplies an identifier outside the supported canonical slug grammar
- **THEN** the command preserves the current active change and reports the accepted grammar

#### Scenario: Missing explicit change
- **WHEN** an action requiring an existing change names a slug with no corresponding change directory
- **THEN** the command preserves the current active change and identifies the missing change and planning home

#### Scenario: Canonical slug collision
- **WHEN** directory resolution finds multiple names that normalize to the requested canonical slug
- **THEN** the command fails closed before selecting either directory and reports the collision

### Requirement: Action-aware read-only dispatch
Standalone exploration SHALL run without resolving or loading an active change. Explicit or remembered status SHALL read state without changing active-change persistence. A change SHALL become active only after a mutating action has passed identity validation and action prerequisites.

#### Scenario: Explore while remembered change is corrupt
- **WHEN** a remembered change has malformed or unreadable artifacts and the user invokes `/change explore <prompt>`
- **THEN** exploration runs without loading that change snapshot

#### Scenario: Status names another change
- **WHEN** a user invokes `/change status other-change`
- **THEN** status reads `other-change` and leaves the previously active change unchanged

#### Scenario: Mutating action is rejected
- **WHEN** a mutating command names a valid change but fails lifecycle prerequisites
- **THEN** the rejected invocation does not replace the active change

### Requirement: Actionable prerequisite diagnostics
Blocked commands SHALL report the concrete unsatisfied prerequisite and a valid recovery action. Diagnostics SHALL distinguish missing artifacts, stale review or verification digests, unavailable required models, pending manual checkpoints, invalid persisted evidence, and unsupported external capabilities.

#### Scenario: Required artifact is absent
- **WHEN** a phase requires an OpenSpec artifact that does not exist
- **THEN** the result names the missing artifact and the command that can create or repair it

#### Scenario: Review evidence is stale
- **WHEN** the current planning-artifact digest differs from the approved review digest
- **THEN** implementation remains blocked and the result identifies both the stale review and `/change review <change>` as the next action

#### Scenario: Manual checkpoint is pending
- **WHEN** implementation or recovery observes one or more pending checkpoints
- **THEN** the result lists their checkpoint IDs and gives the exact `/change resume <change> <checkpoint-id>` form

#### Scenario: Required model is unavailable
- **WHEN** routing cannot select an authenticated model for a mandatory role
- **THEN** no agent starts and the result names the unavailable role or provider capability

### Requirement: Persistent command outcomes
Every advertised command invocation SHALL produce a persistent terminal result classified as success, blocked, cancelled, or failure. The result SHALL identify the action, change when applicable, run identity when created, and the next action or corrective guidance when work did not succeed. Transient UI notifications MAY supplement but SHALL NOT replace this result.

#### Scenario: Default registration acceptance sweep
- **WHEN** acceptance tests invoke every advertised action through default `registerMuster()` dependencies with controlled external boundaries
- **THEN** each invocation records or emits exactly one persistent terminal result and none relies on an injected command-handler map

#### Scenario: Unexpected production failure
- **WHEN** a production dependency throws an unexpected error
- **THEN** the invocation emits a persistent failure result with bounded diagnostic detail and does not disappear as a transient notification only

