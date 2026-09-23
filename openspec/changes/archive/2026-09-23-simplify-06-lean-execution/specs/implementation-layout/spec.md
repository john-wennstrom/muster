## ADDED Requirements

### Requirement: The implementation phase is a thin orchestrator

The implementation phase entry point SHALL contain only argument handling, worktree selection, task graph compilation, the scheduler call and result mapping. Run manifest handling and the per-task execution unit SHALL be separate modules, none larger than about 250 lines.

#### Scenario: The phase file delegates

- **WHEN** the implementation phase file is inspected
- **THEN** it contains no manifest schema handling and no per-task builder, verification or review sequencing

### Requirement: The run manifest has one owner

Creating, reading, validating and persisting the run manifest, including its lane, SHALL be done by one module, and no other module SHALL write the manifest file.

#### Scenario: One writer of the manifest

- **WHEN** the source tree is searched for writes to the manifest file
- **THEN** exactly one module performs them

### Requirement: Decomposition preserves behavior

The decomposition SHALL NOT change the persisted records or the reported result of a run that involves no merged task, skipped review or recovery decision.

#### Scenario: The same run produces the same records

- **WHEN** an existing implementation test scenario runs after the decomposition
- **THEN** its persisted records and reported result are unchanged
