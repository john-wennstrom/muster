## Purpose

Defines runtime-enforced permissions and engineering disciplines that protect correctness even when an agent prompt is ignored or misunderstood.

## ADDED Requirements

### Requirement: Process and tool enforcement
Role read/write boundaries SHALL be enforced by authenticated brokered tools, tool allowlists, canonical path checks, task state, and writer-lease checks. Prompt instructions SHALL NOT be the only permission boundary.

#### Scenario: Read-only reviewer attempts a write
- **WHEN** a reviewer invokes any tool or child process that would mutate the repository
- **THEN** the operation is denied, recorded, and cannot change the worktree

### Requirement: Host command execution controls
The beta SHALL execute agent-requested commands through a brokered host command runner with an explicit working directory, environment allowlist, timeout, output limit, cancellation, prohibited-operation classification, and post-command repository diff audit on Linux, macOS, and native Windows. The beta SHALL disclose that it does not provide operating-system process or network isolation and SHALL NOT describe host command execution as sandboxed.

#### Scenario: Host command exceeds its boundary
- **WHEN** an agent-requested command exceeds its timeout or output limit, requests a prohibited operation, or produces an out-of-scope repository change
- **THEN** the harness terminates or rejects the command, records the violation, and does not accept the task result

#### Scenario: User inspects beta isolation
- **WHEN** a user inspects status, help, or security documentation
- **THEN** the harness states that broker and audit controls are active and operating-system process and network isolation are deferred

### Requirement: Scoped source writes
A write-enabled role SHALL be able to mutate only its declared worktree and allowed write paths while holding the writer lease. Attempts through shell commands, Serena, or any other adapter SHALL obey the same boundary.

#### Scenario: Builder writes outside its scope
- **WHEN** a builder attempts to modify a path not listed in its task metadata
- **THEN** the write is blocked and the task fails with an auditable permission violation

### Requirement: Test-driven implementation policy
For behavior-changing tasks, the harness SHALL require evidence of a relevant failing check before implementation, a passing check after implementation, and passing checks after refactoring unless the task metadata contains an approved non-applicability rationale.

#### Scenario: Behavior task has no red-stage evidence
- **WHEN** a builder attempts to complete a behavior-changing task without a captured failing test or approved exception
- **THEN** the task review rejects completion

### Requirement: Systematic debugging activation
Persistent unexpected failures SHALL activate a debugging contract that records reproduction, evidence, a root-cause hypothesis, a discriminating check, a minimal fix, and regression verification.

#### Scenario: Repeated repair does not pass
- **WHEN** the configured number of ordinary repair attempts fails
- **THEN** the task enters debugging mode instead of continuing unguided patch attempts

### Requirement: Mandatory gates survive budget pressure
Token or cost limits MAY remove optional opinions, debate rounds, or exploratory models, but SHALL NOT remove required tests, review, validation, OpenSpec integrity, permission enforcement, or manual checkpoints.

#### Scenario: Budget is exhausted before review
- **WHEN** an implementation run reaches its token budget before mandatory task review
- **THEN** the task stops as budget-blocked and is not marked complete

### Requirement: Prohibited operation interception
Agents SHALL NOT directly supply secrets, elevate privileges, execute destructive operations, or cause external side effects. Detection SHALL create a manual checkpoint before execution.

#### Scenario: Builder proposes force push
- **WHEN** a child attempts a force push or history rewrite
- **THEN** the operation is prevented and the task enters the destructive-action manual checkpoint flow