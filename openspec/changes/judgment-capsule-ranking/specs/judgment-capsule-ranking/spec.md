## Purpose

Defines how a task's context capsule is packed by relevance rather than list order when a ranking is available, how slices the ranking judges unnecessary are demoted to on-demand, how oversized required slices are surfaced, and how escalation requests can be authorized from a stored ranking.

## ADDED Requirements

### Requirement: Necessity means needed to do the work

The question asked about each slice SHALL ask how necessary the slice is to completing the task, on an ordered rubric whose levels are unrelated, background, useful, and required, and SHALL state that necessity means needed to do the work rather than topically related to it.

#### Scenario: Question distinguishes necessary from related

- **WHEN** the question asked about a slice is inspected
- **THEN** it asks about necessity to complete the task, names the four ordered levels, and states that topical relatedness alone is not necessity

### Requirement: Relevant slices are packed by necessity

When a ranking is supplied, relevant slices SHALL be considered in descending order of necessity score multiplied by confidence, with ties kept in list order, and each SHALL be included when it fits the remaining budget. The capsule's required content, its token budget, and the meaning of excluded slices SHALL be unchanged, and a capsule SHALL NOT exceed its token budget.

#### Scenario: Higher-ranked slice is packed first

- **WHEN** two relevant slices compete for the remaining budget and the later one in the list is ranked higher
- **THEN** the higher-ranked slice is included and the other is listed as available on demand

#### Scenario: Budget is never exceeded

- **WHEN** a capsule is assembled with any ranking
- **THEN** its token estimate does not exceed its token budget

#### Scenario: Required content is unchanged

- **WHEN** a capsule is assembled with a ranking
- **THEN** the task contract and any required slices appear exactly as they do without a ranking

### Requirement: Confidently unnecessary slices are demoted

A relevant slice whose necessity score is below 0.5 with confidence of at least 0.7 SHALL be listed as available on demand rather than included, even when budget remains.

#### Scenario: Unrelated slice is demoted despite spare budget

- **WHEN** a relevant slice is ranked unrelated with confidence 0.9 and the budget has room for it
- **THEN** the slice is listed as available on demand and is not included

### Requirement: Uncertain and unscored slices keep today's treatment

A slice whose ranking is not confident SHALL NOT be demoted. A slice with no ranking SHALL be considered after every ranked slice, in list order.

#### Scenario: Low-confidence slice is not demoted

- **WHEN** a relevant slice is ranked unrelated with confidence 0.4 and the budget has room for it
- **THEN** the slice is included

#### Scenario: Unscored slices follow scored slices in list order

- **WHEN** some relevant slices have a ranking and others do not
- **THEN** the unranked slices are considered after the ranked ones, in their list order

### Requirement: Without a ranking the capsule is unchanged

When no ranking is supplied, the capsule — its content, included, available, and excluded slices, and token estimate — SHALL be identical to the capsule produced without this capability for the same inputs.

#### Scenario: No ranking gives today's capsule

- **WHEN** a capsule is assembled without a ranking
- **THEN** every field equals the capsule produced without this capability for the same inputs

### Requirement: A required slice that does not fit is reported, not fatal

A slice ranked required with confidence of at least 0.7 that cannot fit the remaining budget SHALL be listed on the capsule with its score, confidence, and token estimate, and assembly SHALL NOT fail on that account. Content that is genuinely required by the capsule's contract and exceeds the budget SHALL continue to fail as it does today.

#### Scenario: Oversized required slice is listed

- **WHEN** a slice is ranked required with confidence 0.9 and does not fit the budget
- **THEN** the capsule is produced and lists the slice with its score, confidence, and estimate

#### Scenario: Genuinely required content still fails when over budget

- **WHEN** the task's required content alone exceeds the token budget
- **THEN** assembly fails exactly as it does without a ranking

### Requirement: Ranking-based authorization stays inside the available set

Authorization derived from a stored ranking SHALL approve a context escalation only for a slice the capsule lists as available on demand, within the remaining tokens, whose necessity score is at least 1.5 with confidence of at least 0.6. A request that is for an excluded or unknown source, or that exceeds the remaining tokens, SHALL be refused before the ranking is consulted. A slice with no ranking SHALL NOT be authorized on the ranking's account.

#### Scenario: Ranked available slice is authorized

- **WHEN** an escalation is requested for an available slice ranked useful with confidence 0.8 and within the remaining tokens
- **THEN** the escalation is authorized

#### Scenario: Excluded slice is refused regardless of ranking

- **WHEN** an escalation is requested for an excluded slice that the ranking scored as required
- **THEN** the escalation is refused

#### Scenario: Unranked slice is not authorized by ranking

- **WHEN** an escalation is requested for an available slice that has no ranking
- **THEN** the ranking does not authorize it

### Requirement: Shadow mode packs as today and records the counterfactual

In shadow mode the capsule SHALL be the capsule produced without a ranking. The decision record SHALL hold which slices ranking would have included, demoted, and listed as oversized, and whether the capsule would have differed. The record SHALL be reconcilable with the slices later requested by escalation, so that escalations ranking would have avoided and escalations it would have caused can be counted.

#### Scenario: Shadow capsule is unchanged

- **WHEN** ranking runs in shadow mode
- **THEN** the capsule equals the capsule produced without a ranking and the record shows what ranking would have changed

#### Scenario: Escalations are reconciled with the counterfactual

- **WHEN** escalations occur after a shadow-mode ranking
- **THEN** the record holds the escalated slices and whether each was one ranking would have included

### Requirement: Ranking state is bounded

At most thirty slices SHALL be scored in one request, each represented by an excerpt of at most 600 bytes. Slices beyond the first thirty in list order SHALL be unscored. A request whose state is too large for the judgment layer SHALL be treated as unavailable.

#### Scenario: Slices beyond the cap are unscored

- **WHEN** a task has more than thirty relevant slices
- **THEN** only the first thirty are scored and the rest are treated as unscored

### Requirement: Unavailable ranking yields today's capsule

For every unavailable reason, the capsule SHALL be identical to the capsule produced without a ranking. When judgment is disabled, no ranking work SHALL be performed.

#### Scenario: Every unavailable reason yields the unranked capsule

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, and model mismatch
- **THEN** the capsule equals the capsule produced without a ranking

#### Scenario: Disabled judgment adds no work

- **WHEN** judgment is disabled
- **THEN** no request is sent, no record is written, and capsule assembly behaves as it does without judgment

### Requirement: Slice egress is documented

The security documentation SHALL list, for this decision, the state that leaves the machine: the task contract and the slice excerpts, which may include source, specification text, and dependency reports, with a note on how file-backed slices are identified for the credential denylist.

#### Scenario: Security documentation lists the ranking egress

- **WHEN** the security documentation's per-call-site table is read
- **THEN** it has a row for context capsule ranking naming exactly that state
