## Purpose

Defines model-role execution, context isolation, provider routing, budgeted task capsules, and optional integration behavior for child agents.

## ADDED Requirements

### Requirement: Fresh role contexts
Architects SHALL be recreated for material planning revisions, builders SHALL start fresh for each task, reviewers SHALL start fresh for each review, and validators SHALL start fresh for each completed change.

#### Scenario: Consecutive builder tasks
- **WHEN** two dependent implementation tasks are executed
- **THEN** the second builder receives a new session containing curated dependency evidence rather than the first builder's conversation transcript

### Requirement: Independent review context
A reviewer SHALL NOT resume or fork the authoring session whose output it reviews and SHOULD use a different eligible model when one is available.

#### Scenario: Multiple eligible models
- **WHEN** an artifact author used one model and another review-capable model is configured
- **THEN** the harness assigns the fresh reviewer to a different model and records the assignment

### Requirement: Task-scoped context capsules
Each builder SHALL receive the task definition, relevant requirement and scenario excerpts, applicable design decisions, dependency reports, project rules, selected code context, read/write scopes, acceptance conditions, and token budget. Unrelated artifacts and transcripts SHALL be excluded by default.

#### Scenario: Builder needs omitted context
- **WHEN** a builder requests additional context
- **THEN** the harness checks relevance, permissions, and remaining budget before supplying a bounded additional slice or returning a clear denial

### Requirement: Context priority
Context assembly SHALL classify material as required, relevant, available-on-demand, or excluded, and SHALL never truncate required context to preserve optional context.

#### Scenario: Capsule exceeds budget
- **WHEN** selected context exceeds the task budget
- **THEN** optional and referenceable material is reduced before any required requirement, scenario, permission, or acceptance content

### Requirement: Provider abstraction and beta support
Provider-specific behavior SHALL remain behind the host model registry and routing interfaces. The beta SHALL verify at least one usable OpenAI model and SHALL retain other compatible Fusion/Pi providers without hard-coding role behavior to a vendor.

#### Scenario: Required OpenAI provider unavailable
- **WHEN** beta startup validation cannot resolve and authenticate any configured OpenAI model
- **THEN** startup reports the missing provider capability and OpenAI-dependent acceptance checks do not run

### Requirement: Honest provider capability reporting
The harness SHALL NOT advertise GitHub Copilot child execution while Pi cannot spawn it. Provider extension points SHALL permit a future VS Code Copilot adapter without changing role contracts.

#### Scenario: User selects unavailable Copilot execution
- **WHEN** no VS Code Copilot adapter is installed and a role is configured for Copilot
- **THEN** configuration validation fails with a diagnostic identifying the deferred adapter requirement

### Requirement: Optional Serena and Hindsight adapters
Serena and Hindsight SHALL be capability-detected optional adapters. Their absence SHALL NOT prevent core startup, and their data SHALL remain supplemental to repository and OpenSpec state.

#### Scenario: Optional integrations absent
- **WHEN** neither Serena nor Hindsight is installed
- **THEN** core change workflows load without those capabilities and status reports them as unavailable rather than failed

### Requirement: Compact inter-agent handoff
Agents SHALL exchange bounded decision and dependency reports by default rather than broadcasting complete transcripts or fused outputs.

#### Scenario: Builder dependency completes
- **WHEN** a dependent task becomes eligible
- **THEN** its builder receives the predecessor's structured report and relevant changed interfaces without receiving the predecessor's full transcript