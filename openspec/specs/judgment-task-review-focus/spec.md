# judgment-task-review-focus Specification

## Purpose

Defines how a task code reviewer is pointed at the parts of a change most likely to matter: an advisory focus list derived from typed judgments over the review inputs the harness already assembles, without changing who decides the verdict or any review gate.

## Requirements

### Requirement: The reviewer receives an advisory focus list

In enforce mode, when at least one judgment crosses its threshold, the reviewer's prompt SHALL contain a focus block listing the areas of attention. The block SHALL tell the reviewer to disregard the focus wherever the diff does not support it. The rest of the prompt SHALL be unchanged.

#### Scenario: Focus block is added

- **WHEN** judgment in enforce mode indicates that the tests do not cover a scenario
- **THEN** the reviewer's prompt contains a focus block naming test coverage of the task's scenarios, and every other part of the prompt is unchanged

#### Scenario: Focus is advisory

- **WHEN** the focus block is inspected
- **THEN** it instructs the reviewer to disregard it wherever the diff does not support it

### Requirement: Focus items are fixed phrases

Every focus item SHALL be one of a fixed catalogue of phrases chosen by which answers crossed their thresholds; no item SHALL contain text written by a model. A prompt SHALL contain at most four items, in a fixed priority order.

#### Scenario: Items come from the catalogue

- **WHEN** a focus block is produced
- **THEN** each item is exactly one of the catalogued phrases

#### Scenario: Items are capped and ordered

- **WHEN** more than four answers cross their thresholds
- **THEN** the block lists four items, chosen and ordered by the fixed priority

### Requirement: No signal leaves the prompt unchanged

When no answer crosses its threshold, the reviewer's prompt SHALL be identical to the prompt produced without this capability.

#### Scenario: No signal gives today's prompt

- **WHEN** every answer lies inside its uncertain band
- **THEN** the reviewer's prompt equals the prompt produced without judgment

### Requirement: Unavailable judgment yields today's review

For every unavailable reason the reviewer's prompt SHALL be identical to today's. When judgment is disabled, the review step SHALL perform no judgment work.

#### Scenario: Every unavailable reason yields today's prompt

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, model mismatch, and a state too large to send
- **THEN** the reviewer's prompt equals the prompt produced without judgment

#### Scenario: Disabled judgment adds no work

- **WHEN** judgment is disabled
- **THEN** no request is sent, no record is written, and the review step behaves as it does without judgment

### Requirement: Shadow mode leaves the prompt unchanged and records the focus

In shadow mode the reviewer's prompt SHALL be identical to today's. The decision record SHALL hold the focus items that would have been given.

#### Scenario: Shadow prompt is unchanged

- **WHEN** judgment runs in shadow mode with answers that would have produced a focus block
- **THEN** the reviewer's prompt equals the prompt produced without judgment and the record lists the focus items that would have been given

### Requirement: Records are reconciled with the review's findings

After the review completes, the decision record SHALL hold the number of required findings and of recommendations, the areas in which findings were raised, and which focus items named an area in which the reviewer raised a finding. A report SHALL compare finding counts between reviews that received a focus list and reviews that did not.

#### Scenario: Review outcome is recorded

- **WHEN** a review completes for a task with a decision record
- **THEN** the record holds the finding counts, the areas raised, and which focus items named an area the reviewer raised

#### Scenario: Report compares focused and unfocused reviews

- **WHEN** records for reviews with and without a focus list are summarized
- **THEN** the report gives each group's review count and mean finding counts, and the share of focus items that named an area the reviewer raised

### Requirement: The review state is bounded

The state sent for judgment SHALL contain an excerpt of the diff of at most 24,000 bytes together with the complete list of changed paths, and every changed path SHALL be declared for the credential denylist. A state that is still too large for the judgment layer SHALL be treated as unavailable.

#### Scenario: Oversized diff is excerpted with the full file list

- **WHEN** a diff exceeds 24,000 bytes
- **THEN** the state holds an excerpt within that limit and the complete list of changed paths

### Requirement: Judgment never changes a review gate

Every task SHALL still be reviewed by the reviewer, whatever judgment answers. The task's approval SHALL derive only from the reviewer's review: a reviewer that requires changes SHALL block the task even when judgment raised no concern, and a reviewer that approves SHALL approve it even when judgment raised concerns.

#### Scenario: Every task is still reviewed

- **WHEN** judgment answers that every check passes
- **THEN** the reviewer still runs for the task

#### Scenario: Task outcome depends only on the reviewer

- **WHEN** the reviewer's verdict differs from what the focus suggested, in either direction
- **THEN** the task's approval follows the reviewer's verdict

### Requirement: Review focus egress is documented

The security documentation SHALL list, for this decision, the state that leaves the machine: the task contract, the diff excerpt with the changed paths, the test output, the authorized scopes, and the test-first evidence.

#### Scenario: Security documentation lists the review focus egress

- **WHEN** the security documentation's per-call-site table is read
- **THEN** it has a row for task review focus naming exactly that state
