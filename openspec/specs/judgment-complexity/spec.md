# judgment-complexity Specification

## Purpose

Defines how the four risk inputs to complexity classification — public contract, data migration, security boundary, and design ambiguity — are determined from a planning request: judged when confident, falling back per signal to pattern matching, without changing the classification ladder, overrides, or orchestration policy.

## Requirements

### Requirement: Risk inputs are judged when confident

For each of the four risk inputs, a judgment answer with probability above 0.7 SHALL set the input, and a probability below 0.3 SHALL clear it, regardless of the pattern value. Judgment SHALL be used only in enforce mode.

#### Scenario: Pattern false positive is corrected

- **WHEN** a request that explicitly avoids a migration matches the migration pattern and judgment answers the migration question below 0.3 in enforce mode
- **THEN** the data-migration input is false and the request is not escalated on account of migration

#### Scenario: Pattern false negative is corrected

- **WHEN** a request to change a wire format between two components matches none of the patterns and judgment answers the public-contract question above 0.7 in enforce mode
- **THEN** the public-contract input is true

### Requirement: Uncertain inputs fall back one signal at a time

A risk input whose judgment probability lies between 0.3 and 0.7 inclusive SHALL take its pattern value. The other inputs SHALL be determined independently of it.

#### Scenario: Uncertain signal uses the pattern value

- **WHEN** judgment answers the security-boundary question at 0.5
- **THEN** the security-boundary input equals the value the pattern match produces for the same request

#### Scenario: Other signals are unaffected

- **WHEN** one signal is uncertain and another is answered confidently
- **THEN** the uncertain signal takes its pattern value and the confident signal takes its judged value

### Requirement: Classification and overrides are unchanged

For any given values of the four inputs, the affected files, and the affected capabilities, the classification, its severity signals, its reason, and the resulting orchestration policy SHALL be identical to what they are without judgment. Judgment SHALL NOT apply, remove, or alter an override, and an override SHALL remain subject to its mandatory auditable reason.

#### Scenario: Same inputs classify the same

- **WHEN** the same four input values are produced with or without judgment
- **THEN** the classification decision and orchestration policy are identical

#### Scenario: Overrides are untouched

- **WHEN** a classification override is supplied
- **THEN** it is applied and audited exactly as it is without judgment, whatever judgment answers

### Requirement: Negation and scope are read as written

The question for each risk input SHALL state its own scoping so that it is read literally. The migration question SHALL state that a request which explicitly avoids a migration answers no, and the public-contract question SHALL state that an internal function signature is not a public contract.

#### Scenario: Avoided migration answers no

- **WHEN** the request is "don't migrate the data, just add a column" and a recorded judgment response for it is replayed in enforce mode
- **THEN** the data-migration input is false

#### Scenario: Internal signature change is not a public contract change

- **WHEN** the request changes only an internal function signature and a recorded judgment response for it is replayed in enforce mode
- **THEN** the public-contract input is false

### Requirement: Design ambiguity applies only in refinement

The judged design-ambiguity answer SHALL be applied to classification only when the planning phase is refinement. In every other phase the input SHALL remain false, and the judged answer SHALL still be recorded.

#### Scenario: Proposal ignores judged design ambiguity

- **WHEN** the planning phase is proposal and judgment answers the design-ambiguity question above 0.7 in enforce mode
- **THEN** the design-ambiguity input is false and the record shows the answer was not applied

#### Scenario: Refinement uses judged design ambiguity

- **WHEN** the planning phase is refinement and judgment answers the design-ambiguity question above 0.7 in enforce mode
- **THEN** the design-ambiguity input is true

### Requirement: Additional signals are recorded and never acted on

The answers to how mechanical the change is and how far it reaches SHALL be recorded with the decision and SHALL NOT influence the four inputs or the classification.

#### Scenario: Recorded-only signals do not change classification

- **WHEN** the mechanical and reach answers vary while every other answer is held fixed
- **THEN** the classification decision is identical

### Requirement: Shadow mode measures agreement without changing classification

In shadow mode the four inputs SHALL be the pattern values, exactly as without judgment. The decision record SHALL hold, for every signal, the judged value or abstention beside the pattern value, and each record SHALL be reconciled with whether every confident signal agreed with its pattern value. Agreement SHALL be reportable per signal, together with the number of changes measured.

#### Scenario: Shadow classification is unchanged

- **WHEN** judgment runs in shadow mode with answers that disagree with the patterns
- **THEN** the four inputs and the classification equal those produced without judgment

#### Scenario: Agreement is reported per signal

- **WHEN** the records of several shadow-mode planning runs are summarized
- **THEN** each signal's agreement rate and the number of changes measured are reported, and disagreements are distinguishable by direction

### Requirement: Unavailable judgment yields today's classification

For every unavailable reason, the four inputs and the resulting classification SHALL be identical to the pattern-only result. When judgment is disabled, planning SHALL NOT perform any judgment work.

#### Scenario: Every unavailable reason yields the pattern classification

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, and model mismatch
- **THEN** the classification decision is identical to the pattern-only decision

#### Scenario: Disabled judgment adds no work

- **WHEN** judgment is disabled
- **THEN** no request is sent, no record is written, and planning behaves as it does without judgment

### Requirement: Request egress is documented

The security documentation SHALL list, for this decision, the state that leaves the machine: the effective request text, the planning phase, and the preflight evidence paths and reasons.

#### Scenario: Security documentation lists the complexity egress

- **WHEN** the security documentation's per-call-site table is read
- **THEN** it has a row for complexity classification naming exactly that state
