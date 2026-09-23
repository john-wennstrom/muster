## Purpose

Defines how OpenSpec tasks become a validated runtime DAG with worktree isolation, serialized writes, bounded concurrency, and evidence-based completion.

## ADDED Requirements

### Requirement: Structured task execution metadata
Each executable OpenSpec task SHALL have one adjacent fenced YAML `harness-task` block defining its identifier, dependencies, role, allowed read and write paths, linked requirements and scenarios, verification commands, and optional manual-action contract. The harness SHALL reject missing, duplicate, unknown, or contradictory metadata before execution.

#### Scenario: Task metadata is incomplete
- **WHEN** an executable task omits its write scope or verification contract
- **THEN** DAG compilation fails before any builder starts and identifies the task and missing fields

#### Scenario: Checkbox and metadata identifiers differ
- **WHEN** a task checkbox identifier does not equal the adjacent metadata identifier
- **THEN** validation rejects the task plan as ambiguous

### Requirement: Derived dependency DAG
The runtime DAG SHALL be reconstructable from current OpenSpec tasks and their structured metadata. It SHALL reject cycles, unknown dependencies, duplicate identifiers, and dependencies on incomplete removed tasks.

#### Scenario: Dependency cycle
- **WHEN** task metadata contains a cycle
- **THEN** implementation stops before dispatch and reports the complete cycle path

### Requirement: Controller-owned dedicated worktree
Implementation SHALL run in a dedicated Git worktree selected or created by the controller for the change. Child agents SHALL NOT create, remove, or switch worktrees.

#### Scenario: Implement from the planning checkout
- **WHEN** a change has no existing implementation worktree
- **THEN** the controller creates a deterministic dedicated worktree and all source-writing agents use it

#### Scenario: Repository cannot support worktrees
- **WHEN** Git worktree prerequisites are unavailable or unsafe
- **THEN** implementation fails before a writer starts and reports the corrective action; it does not silently write in the planning checkout

### Requirement: Global source-writer lease
At most one source-writing task SHALL hold the writer lease for a worktree at any time, including writes attempted through optional tools. Lease enforcement SHALL occur outside agent prompts.

#### Scenario: Concurrent write-ready tasks
- **WHEN** two independent write tasks become ready
- **THEN** only one receives write capability while the other remains queued until the lease is released

### Requirement: Safe read concurrency
The scheduler SHALL permit dependency-ready read-only reasoning to overlap with a writer or other readers when its brokered tools and task context do not grant mutation capability.

#### Scenario: Independent analysis task
- **WHEN** a read-only task is independent of the active writer
- **THEN** the scheduler may run both concurrently and records their separate states

### Requirement: Dependency and gate ordering
A task SHALL become eligible only after all dependencies complete their configured tests and review gates. Failed or paused tasks SHALL block their dependent DAG branches.

#### Scenario: Focused test failure
- **WHEN** a builder finishes editing but the task's required focused test fails
- **THEN** the task is not marked complete and no dependent task is dispatched

### Requirement: Design conflict outcome
A builder SHALL be able to return a structured design conflict with evidence, affected artifacts, affected tasks, and an optional recommendation. The harness SHALL stop the affected branch, return planning control to an architect, invalidate stale review, and require re-review before resumption.

#### Scenario: Repository contradicts approved design
- **WHEN** a builder provides evidence that the approved design cannot satisfy a requirement
- **THEN** affected dependent tasks stop and implementation cannot resume until the planning artifacts and review are current

### Requirement: Durable task completion synchronization
An OpenSpec task checkbox SHALL be marked complete only after implementation, required verification commands, task review, and evidence persistence succeed.

#### Scenario: Agent claims completion without evidence
- **WHEN** a builder reports success but a required gate has no passing evidence
- **THEN** the task remains incomplete in OpenSpec