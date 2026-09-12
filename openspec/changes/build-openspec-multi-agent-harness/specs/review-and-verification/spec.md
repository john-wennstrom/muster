## Purpose

Defines independent planning and code review, artifact freshness, final verification evidence, and the boundary between verification and finishing a change.

## ADDED Requirements

### Requirement: Fresh read-only planning review
Planning review SHALL run in a fresh read-only context over proposal, design, delta specs, tasks, relevant current specs, and selected repository evidence.

#### Scenario: Planning artifacts are ready
- **WHEN** `/change review` is invoked with all required artifacts present
- **THEN** a fresh reviewer receives the complete reviewed set and cannot modify planning or source files

### Requirement: Binary planning verdict
Planning review SHALL produce exactly `APPROVE` or `REVISE`. A review with required changes SHALL use `REVISE`, and implementation SHALL require `APPROVE`.

#### Scenario: Reviewer identifies required correction
- **WHEN** the reviewer identifies any blocking or required planning change
- **THEN** the durable verdict is `REVISE` and implementation remains blocked

### Requirement: Deterministic artifact digest
The harness SHALL calculate and record a deterministic SHA-256 digest over the reviewed proposal, design, task file, and delta-spec paths and contents.

#### Scenario: Reviewed content is unchanged
- **WHEN** only runtime files outside the reviewed set change
- **THEN** the recorded planning approval remains current

#### Scenario: Reviewed artifact changes
- **WHEN** any reviewed path or content changes after approval
- **THEN** the approval is mechanically stale before another implementation task starts

### Requirement: Independent task code review
Each source-writing task SHALL receive a fresh read-only review against its task contract, linked requirements, design constraints, diff, and test evidence before completion.

#### Scenario: Task review fails
- **WHEN** the reviewer finds a blocking defect or out-of-scope write
- **THEN** the task returns for repair and cannot unblock dependents

### Requirement: Evidence-based final verification
Final verification SHALL run in a fresh read-only context and SHALL independently check current OpenSpec validation, task completion, requirement/scenario evidence, focused and full tests, review findings, design alignment, unresolved reports, review freshness, and understood repository/worktree state.

#### Scenario: Builder reports all work complete
- **WHEN** builder reports are successful but a required full test suite fails
- **THEN** final verification fails and the change is not ready to finish

### Requirement: Durable verification summary
Verification SHALL write a durable `verification.md` containing commands and outcomes, requirement/scenario evidence, resolved review findings, deviations, warnings, current diff or commit identity, and a final pass/fail result without storing raw model transcripts.

#### Scenario: Verification passes
- **WHEN** every mandatory verification check succeeds
- **THEN** `verification.md` contains reproducible evidence and status reports the change as ready for explicit finish

### Requirement: Explicit finish boundary
Verification SHALL NOT commit, merge, push, archive, publish, deploy, or remove a worktree. `/change finish` SHALL recheck verification freshness before delegating archive to OpenSpec.

#### Scenario: Source changes after verification
- **WHEN** source or relevant OpenSpec artifacts change after a passing verification
- **THEN** `/change finish` refuses to archive until verification is refreshed