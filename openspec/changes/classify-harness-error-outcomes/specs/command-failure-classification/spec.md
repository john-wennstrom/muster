## Purpose

Defines how a raised failure becomes a user-facing `/change` outcome: the exhaustive contract between declared error codes and their presentation, the guarantees each classified failure provides, and the treatment of unrecognized failures.

## ADDED Requirements

### Requirement: Exhaustive error classification

Every declared error code SHALL have exactly one declared user-facing classification. Declaring a new error code without declaring its classification SHALL be rejected before the change can be built. A classification SHALL NOT be declared for a code that is not declared.

#### Scenario: New error code is declared

- **WHEN** a new error code is added to the declared set without a corresponding classification
- **THEN** the build fails, identifying the code that lacks a classification

#### Scenario: Classification names a code that does not exist

- **WHEN** a classification is declared for a code that is not a member of the declared set
- **THEN** the build fails, identifying the unknown code

#### Scenario: Classification set is audited

- **WHEN** the declared classifications are inspected
- **THEN** each declared code appears exactly once, and whether it is presented as a blocked outcome or a plain failure is readable from that single declaration

### Requirement: Classified failures carry actionable detail

A failure whose code is classified as blocking SHALL report a blocked outcome carrying the blocker category, a description of what is unsatisfied, the affected artifact when the classification identifies one, and the pending checkpoint identifiers when the failure carries them. A failure whose code is classified as non-blocking SHALL report a failure outcome carrying the code and the failure description.

#### Scenario: Blocking failure is raised

- **WHEN** a phase raises a failure whose code is classified as blocking
- **THEN** the invocation reports a blocked outcome whose blocker category matches the declared classification and whose next step is derived from the change and action in scope

#### Scenario: Failure identifies an artifact

- **WHEN** a classification identifies an affected artifact
- **THEN** the reported blocker names that artifact

#### Scenario: Failure carries checkpoint identifiers

- **WHEN** a raised failure carries pending checkpoint identifiers
- **THEN** the reported blocker lists them and the next step directs the user to resume from a checkpoint

### Requirement: Cancellation is distinguished from failure

A cancelled invocation SHALL report a cancelled outcome and SHALL NOT be classified as a failure or as blocked, whether cancellation is signalled by the host's abort mechanism or raised as the declared cancellation code.

#### Scenario: Host cancels an invocation

- **WHEN** the host aborts an in-flight invocation
- **THEN** the invocation reports a cancelled outcome rather than a failure

#### Scenario: Cancellation is raised as an error

- **WHEN** a phase raises the declared cancellation code
- **THEN** the invocation reports a cancelled outcome

### Requirement: Unrecognized failures are declared

A failure that is not a declared error — such as one escaping from a dependency or the host — SHALL be reported with a declared code reserved for unrecognized failures, so every reported outcome carries a code drawn from the declared set.

#### Scenario: Dependency throws an undeclared error

- **WHEN** an invocation fails with an error that carries no declared code
- **THEN** the invocation reports the declared unrecognized-failure code together with the failure description

#### Scenario: Reported code is consumed

- **WHEN** a consumer matches on a reported outcome's code
- **THEN** that code is a member of the declared set

### Requirement: Phase-specific failure attribution

Each phase that can fail because its agent failed SHALL raise a code identifying that phase. A phase SHALL NOT raise another phase's failure code.

#### Scenario: Planning agent fails

- **WHEN** a planning agent invocation fails
- **THEN** the reported and persisted code identifies planning, not exploration

#### Scenario: Failure code is used for attribution

- **WHEN** persisted failure records are grouped by code
- **THEN** failures from different phases are distinguishable
