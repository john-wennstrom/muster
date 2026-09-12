## Purpose

Defines transparent token, cost, duration, routing, and budget evidence so optimization decisions and beta claims remain measurable and honest.

## ADDED Requirements

### Requirement: Per-invocation usage ledger
Every model invocation SHALL record run, phase, role, model, optional task, input tokens, cache-read tokens, cache-write tokens, output tokens, duration, and available estimated cost.

#### Scenario: Provider omits cost
- **WHEN** a provider reports token usage but no price or estimated cost
- **THEN** the ledger preserves the available token fields and represents cost as unavailable rather than zero

### Requirement: Context usage categories
Where the host supplies sufficient data, input usage SHALL be categorized as policy, OpenSpec, repository, dependency, peer, tools, or duplicate context. Estimated categories SHALL be marked as estimates.

#### Scenario: Exact category counts unavailable
- **WHEN** the provider exposes only aggregate input tokens
- **THEN** the harness records the aggregate and does not present inferred category values as exact measurements

### Requirement: Enforced hierarchical budgets
The harness SHALL support run, phase, role, and task budgets. Exceeding a budget SHALL remove optional fan-out first and SHALL produce an explicit blocked result if mandatory work cannot complete within the permitted budget.

#### Scenario: Optional debate exceeds forecast budget
- **WHEN** a design decision can proceed by adjudication and debate would exceed the remaining optional budget
- **THEN** debate is skipped, the reason and estimated saving are recorded, and mandatory review remains scheduled

### Requirement: Compact run summary
Status and completion output SHALL summarize routing, usage, costs when known, skipped optional work, failures, retries, and budget decisions by planning, implementation, and validation phases.

#### Scenario: User inspects completed run
- **WHEN** a run reaches a terminal state
- **THEN** the user can identify which roles and models consumed tokens and why optional work was included or skipped

### Requirement: Secret-safe telemetry
Telemetry SHALL NOT persist prompts, credentials, secret environment values, or raw tool output by default. Diagnostic detail SHALL be bounded and sanitized.

#### Scenario: Authentication checkpoint occurs
- **WHEN** a command output includes a token or device credential
- **THEN** persisted telemetry records the category and event without the credential value

### Requirement: Evidence-based optimization claims
The beta SHALL collect baseline-compatible telemetry but SHALL represent the 25-50% token reduction target as an unverified hypothesis until representative comparative runs demonstrate it without increased escaped defects or final-review findings.

#### Scenario: Insufficient comparative data
- **WHEN** fewer than the configured representative comparisons have completed
- **THEN** reports show observed measurements but do not claim the target reduction has been achieved

### Requirement: Optimization does not redefine correctness
Cost reports SHALL separately identify mandatory and optional usage, and optimization recommendations SHALL NOT propose disabling mandatory gates.

#### Scenario: Mandatory validator is expensive
- **WHEN** telemetry identifies final validation as a major token consumer
- **THEN** recommendations may optimize its context or model routing but do not recommend removing final validation