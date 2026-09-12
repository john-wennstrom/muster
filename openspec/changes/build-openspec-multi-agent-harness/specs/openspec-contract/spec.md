## Purpose

Defines OpenSpec as the authoritative development contract and the machine-readable boundary through which the harness reads, validates, and archives changes.

## ADDED Requirements

### Requirement: Sole durable development contract
The harness SHALL use OpenSpec as the only durable store for proposals, requirements, designs, implementation tasks, planning reviews, verification summaries, and archived change history. It SHALL NOT create a competing permanent plan or specification hierarchy.

#### Scenario: Complete change artifact set
- **WHEN** a planned change reaches verification
- **THEN** its durable intent and evidence exist under OpenSpec and no equivalent permanent `plan.md` or secondary specification tree has been generated

### Requirement: OpenSpec state precedence
Current OpenSpec artifacts and repository state SHALL override conflicting runtime state, model conversation history, Serena data, and Hindsight memory.

#### Scenario: Memory conflicts with current specification
- **WHEN** supplemental memory describes behavior that conflicts with the current OpenSpec requirement
- **THEN** the harness discards the conflicting memory for that decision and follows OpenSpec

### Requirement: Capability handshake
Before an OpenSpec-dependent workflow runs, the harness SHALL verify the presence and machine-readable behavior of every required OpenSpec command instead of relying only on an exact version string.

#### Scenario: Compatible unrecognized version
- **WHEN** the installed OpenSpec version is outside a known version list but all required JSON capabilities pass the handshake
- **THEN** the harness permits the workflow and records the detected version and capabilities

#### Scenario: Missing required capability
- **WHEN** a required JSON command or payload field is unavailable
- **THEN** the workflow stops before mutation with an actionable compatibility diagnostic

### Requirement: Typed structured responses
The adapter SHALL consume structured OpenSpec output for context, status, artifact instructions, apply instructions, validation, and archive operations and SHALL validate response shape before use.

#### Scenario: Malformed OpenSpec JSON
- **WHEN** OpenSpec emits malformed JSON or a payload incompatible with the validated contract
- **THEN** the harness reports the command and validation failure and does not infer missing state from human-readable output

### Requirement: Harness change schema
The project SHALL provide an OpenSpec schema whose durable artifact dependency graph includes proposal, delta specs, design, tasks, pre-implementation review, and verification, with apply requiring a current approved review.

#### Scenario: New harness-controlled change
- **WHEN** a project selects the harness change schema and creates a change
- **THEN** OpenSpec reports the configured artifacts and dependencies, and implementation remains blocked until the review artifact is current and approved

### Requirement: OpenSpec-managed archive
The harness SHALL delegate synchronization and archive semantics to OpenSpec and SHALL NOT reproduce delta merging, retirement, naming, or archive movement itself.

#### Scenario: Finish an accepted change
- **WHEN** the user explicitly invokes finish after successful verification
- **THEN** the harness calls the compatible OpenSpec archive interface and reports its structured result

### Requirement: Explicit OpenSpec failures
Missing artifacts, invalid changes, failed validation, stale review state, and failed archive operations SHALL be blocking and SHALL identify the exact failed prerequisite or command.

#### Scenario: Required artifact is absent
- **WHEN** implementation is requested while a transitive apply prerequisite is absent
- **THEN** no builder starts and the response identifies the missing artifact and the next valid workflow action