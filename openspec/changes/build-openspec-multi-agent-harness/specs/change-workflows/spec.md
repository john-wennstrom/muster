## Purpose

Defines the user-visible change lifecycle, command behavior, complexity routing, autonomous progression, and compatibility behavior of the harness.

## ADDED Requirements

### Requirement: Canonical change commands
The extension SHALL provide `/change explore`, `propose`, `refine`, `review`, `implement`, `verify`, `finish`, `status`, and `resume` commands with consistent change-name resolution and help output.

#### Scenario: Unknown subcommand
- **WHEN** a user enters an unsupported `/change` subcommand
- **THEN** the harness performs no mutation and displays the valid command set and usage

### Requirement: Derived lifecycle state
The harness SHALL derive lifecycle state from current OpenSpec status, review freshness and verdict, Git/worktree state, task state, and persisted run state rather than trusting a model's claim.

#### Scenario: Runtime says approved but digest is stale
- **WHEN** persisted runtime state says a change is approved but a reviewed artifact digest no longer matches
- **THEN** status reports review required and implementation remains blocked

### Requirement: Prerequisite-directed commands
Each mutating workflow command SHALL validate its prerequisites before dispatching agents and SHALL return the exact next valid action when blocked.

#### Scenario: Implement before review
- **WHEN** the user invokes `/change implement` without a current approved planning review
- **THEN** no implementation agent starts and the harness directs the user to `/change review <change>`

### Requirement: Risk-scaled orchestration
The harness SHALL classify work as `direct`, `bounded`, or `architectural` using deterministic signals plus an auditable reason, and SHALL scale optional reasoning without removing mandatory quality gates.

#### Scenario: Localized low-risk task
- **WHEN** a change is classified as direct
- **THEN** the harness uses minimal model fan-out while still enforcing applicable tests, review, permissions, and verification

#### Scenario: Cross-cutting ambiguous change
- **WHEN** a change is classified as architectural
- **THEN** the harness permits specialist opinions and conditional debate and records why the higher-cost route was chosen

### Requirement: Exploration remains non-durable by default
Exploration SHALL create no durable OpenSpec change unless the user explicitly promotes the idea through propose.

#### Scenario: Explore an idea
- **WHEN** `/change explore` completes and the user does not request promotion
- **THEN** no proposal, specification, design, or task artifact is created

### Requirement: Autonomous safe progression
After a user invokes a phase command, the harness SHALL continue through mechanically safe work in that phase without requesting routine confirmations, but SHALL honor mandatory manual checkpoints and quality failures.

#### Scenario: Phase has no blockers
- **WHEN** all prerequisites are met and no manual condition or gate failure occurs
- **THEN** the invoked phase proceeds to its defined completion without an extra approval prompt

### Requirement: Verification and finish are separate
Successful `/change verify` SHALL leave the branch and worktree intact and SHALL NOT create a commit or archive the change. Archive behavior SHALL require a separate explicit `/change finish` invocation.

#### Scenario: Verification succeeds
- **WHEN** final verification passes
- **THEN** verification evidence is written, status reports ready to finish, and no commit, archive, merge, push, or worktree deletion occurs

### Requirement: Legacy command transition
Preserved legacy workflow commands SHALL share the new controller's safety and state checks when their behavior overlaps, while low-level diagnostic commands MAY retain their specialized implementation.

#### Scenario: Legacy implement command
- **WHEN** `/implement` is invoked during the compatibility period
- **THEN** it enforces the same current-review, manual-stop, writer, and verification prerequisites as `/change implement`