## Purpose

Defines minimal runtime persistence and deterministic recovery so interrupted change execution resumes without duplicating accepted source writes.

## ADDED Requirements

### Requirement: Per-run persistent state
Each mutating change run SHALL persist a schema-versioned manifest under `.fusion/runs/<run-id>/` containing change identity, repository and worktree identity, lifecycle state, artifact digest, tasks, model assignments, writer state, checkpoints, and timestamps.

#### Scenario: Run starts
- **WHEN** a mutating workflow creates a run
- **THEN** a manifest exists before the first child mutation and can identify the run after process loss

### Requirement: Runtime data is non-authoritative
Runtime files SHALL be ignored by Git by default and SHALL be reconstructable or invalidatable from OpenSpec, Git, and current worktree state. They SHALL NOT override newer durable state.

#### Scenario: Manifest conflicts with completed OpenSpec task
- **WHEN** a stale manifest says a task is incomplete but current OpenSpec and accepted evidence say it is complete
- **THEN** recovery reconciles to the durable state and records the discrepancy

### Requirement: Atomic state transitions
Manifest, task-result, checkpoint, review, validation, and usage records SHALL be written atomically so an interruption yields either the previous valid record or the complete next record.

#### Scenario: Process exits during state write
- **WHEN** the process terminates while persisting a transition
- **THEN** recovery does not treat a partial file as a valid completed transition

### Requirement: Idempotent recovery
Recovery SHALL inspect OpenSpec, Git diff/commit identity, worktree identity, persisted evidence, and child status before retrying. It SHALL NOT duplicate a completed or accepted source write.

#### Scenario: Crash after source write before task state update
- **WHEN** the harness restarts after files changed but before the task was marked complete
- **THEN** it detects and reviews the existing diff rather than blindly rerunning the builder

### Requirement: Recoverable writer ownership
The writer lease SHALL include enough process and run identity to reject live contention and recover stale ownership after a crashed process without deleting another active run's lease.

#### Scenario: Stale lease after crash
- **WHEN** recovery proves the recorded owner process is no longer alive and the worktree identity matches
- **THEN** it clears the stale lease, records the recovery, and permits the next eligible writer

### Requirement: Resume supported interruption points
Recovery SHALL handle interruption before builder start, during builder execution, before task review, after passing task review, before final verification, and while awaiting user action.

#### Scenario: Restart after passing task review
- **WHEN** accepted review evidence and matching source state exist but the checkbox update did not occur
- **THEN** recovery completes the task-state synchronization without rerunning implementation or review

### Requirement: Corruption fails closed
Unknown manifest schema versions, invalid state transitions, missing referenced worktrees, and corrupt evidence SHALL stop automatic recovery with actionable diagnostics.

#### Scenario: Manifest cannot be parsed
- **WHEN** a persisted run manifest is malformed
- **THEN** the harness does not guess task state or dispatch an agent and reports the affected run path