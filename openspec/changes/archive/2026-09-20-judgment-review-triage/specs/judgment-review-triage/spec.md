## Purpose

Defines when a planning review's approval may be carried forward across an edit that only changes proposal or design prose without repeating the full review, the conditions that keep this safe, and how a carried-forward review is recorded.

## ADDED Requirements

### Requirement: Triage is off unless explicitly enabled

Triage SHALL run only when its own enabling flag is set in addition to judgment being enabled. Otherwise every changed artifact set SHALL receive a full review exactly as it does without judgment, and no snapshot SHALL be retained and no judgment request SHALL be sent on triage's account.

#### Scenario: No flag means full review

- **WHEN** neither judgment nor the triage flag is enabled and a proposal typo is fixed after an approval
- **THEN** a full review is dispatched exactly as without judgment

#### Scenario: Judgment enabled without the triage flag means full review

- **WHEN** judgment is enabled but the triage flag is not set
- **THEN** a full review is dispatched and no triage request is sent

### Requirement: Only immaterial prose edits of an approved review are eligible

An edit SHALL be eligible for carry-forward only when all of the following hold: the previous review approved; a retained copy of the approved artifacts exists; the only artifacts that differ from that copy are the proposal and the design, with no specification or task-list file changed, added, or removed; fewer than three consecutive carry-forwards have already been made; and no additional review instructions were given. Otherwise a full review SHALL be dispatched and no judgment request SHALL be sent.

#### Scenario: Spec edit gets a full review

- **WHEN** a delta specification differs from the approved copy
- **THEN** a full review is dispatched and no judgment request is sent

#### Scenario: Task list edit gets a full review

- **WHEN** the task list differs from the approved copy
- **THEN** a full review is dispatched and no judgment request is sent

#### Scenario: Previous REVISE is never carried forward

- **WHEN** the previous review's verdict is revise
- **THEN** a full review is dispatched and no judgment request is sent

#### Scenario: Missing snapshot gets a full review

- **WHEN** no retained copy of the approved artifacts exists
- **THEN** a full review is dispatched and no judgment request is sent

#### Scenario: Fourth consecutive edit gets a full review

- **WHEN** three consecutive carry-forwards have already been made since the last full review
- **THEN** a full review is dispatched and no judgment request is sent

#### Scenario: Review with instructions gets a full review

- **WHEN** a review is requested with additional instructions
- **THEN** a full review is dispatched and no judgment request is sent

### Requirement: Carry-forward requires an immaterial, confident, non-contradicting answer

An approval SHALL be carried forward only when the judged materiality score is below 1.5 with confidence of at least 0.85 and the probability that the edit changes requirements, changes scenarios, changes tasks, changes scopes, or contradicts what the approval relied on is below 0.25 for each. In every other case a full review SHALL be dispatched.

#### Scenario: Wording-only edit is carried forward

- **WHEN** judgment in enforce mode rates an edit as wording only at confidence 0.95 and every change probability is below 0.1
- **THEN** the approval is carried forward and no reviewer is dispatched

#### Scenario: Added requirement text is not carried forward

- **WHEN** the probability that the edit changes requirements is 0.4
- **THEN** a full review is dispatched

#### Scenario: Uncertain materiality gets a full review

- **WHEN** the materiality confidence is 0.7
- **THEN** a full review is dispatched

### Requirement: A carried-forward review is recorded honestly

A carried-forward review artifact SHALL record the approve verdict, the current artifact digest, the reviewing model of the basis review, an incremented round, the basis review's digest, the running count of consecutive carry-forwards, the judgment's answers, and the decision record, and SHALL preserve the basis review's recommendations. Every consumer of the review SHALL read it as a current approval of the current digest.

#### Scenario: Carry-forward record names its basis and evidence

- **WHEN** an approval is carried forward
- **THEN** the review artifact names the basis digest, the count, the judged answers, and the decision record, and states that it was carried forward

#### Scenario: Lifecycle treats a carried-forward approval as current

- **WHEN** the change's state is derived after a carry-forward
- **THEN** the review is treated as an approval of the current artifact digest, exactly as an ordinary approval is

### Requirement: A full review resets the count

Any full review, whatever its verdict, SHALL produce a review artifact with no carry-forward mark, and the running count SHALL restart from zero.

#### Scenario: Full review after carry-forwards resets the count

- **WHEN** a full review follows two carry-forwards
- **THEN** its artifact carries no carry-forward mark and the next eligible edit may be carried forward up to three times again

### Requirement: Review artifacts stay compatible

A review artifact written without carry-forward marks SHALL remain valid and SHALL be read as a full review. A carried-forward artifact SHALL round-trip through rendering and reading without loss.

#### Scenario: Earlier review artifact still parses

- **WHEN** a review artifact written before this capability is read
- **THEN** it parses successfully and is treated as a full review

#### Scenario: Carried-forward artifact round-trips

- **WHEN** a carried-forward artifact is rendered and read back
- **THEN** every recorded mark and answer is unchanged

### Requirement: Reviewed prose is retained when triage is enabled

When triage is enabled, each approved review SHALL retain the text of the proposal and the design and a digest of every reviewed artifact, keyed by the artifact digest, and at most the three most recent retentions SHALL be kept. When triage is not enabled nothing SHALL be retained.

#### Scenario: Approved review retains a snapshot

- **WHEN** a review approves while triage is enabled
- **THEN** the proposal and design text and every artifact's digest are retained under the approved digest

#### Scenario: Snapshots are pruned

- **WHEN** a fourth approval is retained
- **THEN** only the three most recent retentions remain

#### Scenario: Nothing is retained when triage is off

- **WHEN** a review approves while triage is not enabled
- **THEN** no artifact text is retained

### Requirement: Any doubt or failure means a full review

For every unavailable reason, for a failure to read the retained copy or compute the diff, for a state too large to send, and when the artifacts change while triage is running, a full review SHALL be dispatched exactly as without judgment.

#### Scenario: Every unavailable reason gives a full review

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, and model mismatch
- **THEN** a full review is dispatched exactly as without judgment

#### Scenario: Artifacts changing during triage gives a full review

- **WHEN** the artifact digest differs after the judgment returns from what it was when triage began
- **THEN** no approval is carried forward and a full review is dispatched

### Requirement: Shadow mode always reviews and measures

In shadow mode a full review SHALL be dispatched exactly as without judgment. The decision record SHALL hold whether triage would have carried the approval forward, and SHALL be reconciled with the verdict and required changes of the review that actually ran. The number of edits that would have been carried forward, and how many of those the reviewer did not approve, SHALL be reportable.

#### Scenario: Shadow review is unchanged

- **WHEN** judgment runs in shadow mode with an answer that would have carried the approval forward
- **THEN** a full review is dispatched and its result is the review's result

#### Scenario: False skips are reported

- **WHEN** the records of several shadow-mode triage decisions are summarized
- **THEN** the report gives how many would have been carried forward and how many of those were followed by a review that did not approve

### Requirement: Only the diff of prose leaves the machine

The state sent for judgment SHALL consist of the unified diffs of the proposal and the design, with five lines of context, of at most 16,000 bytes in total, and the previous review's recommendations. A state that exceeds the limit SHALL be treated as unavailable.

#### Scenario: State holds only prose diffs

- **WHEN** an edit is sent for judgment
- **THEN** the state holds only the proposal and design diffs and the previous recommendations, and no specification or task-list text

### Requirement: Triage egress is documented

The security documentation SHALL list, for this decision, the state that leaves the machine: the proposal and design diffs and the previous review's recommendations, and SHALL name the triage flag.

#### Scenario: Security documentation lists the triage egress

- **WHEN** the security documentation's per-call-site table is read
- **THEN** it has a row for review triage naming exactly that state and the flag
