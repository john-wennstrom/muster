# judgment-thrash-detection Specification

## Purpose

Defines how a repair loop's failure history is assessed for lack of progress so the loop can be cut short: escalating to systematic debugging early when repeated failures share a root cause without progress, and stopping for a human when a failure needs a decision, credential, or access an automated agent cannot obtain. Judgment never lengthens a loop.

## Requirements

### Requirement: Judgment can only shorten a repair loop

Whatever judgment answers, the attempt at which a task moves to systematic debugging SHALL be no later than the attempt at which it moves without judgment, the configured threshold SHALL NOT be raised, and ordinary repair SHALL remain disabled once systematic debugging has begun.

#### Scenario: Escalation is never later than the threshold

- **WHEN** any failure history is run with any judgment answers, including none and unavailable
- **THEN** the task moves to systematic debugging at an attempt no later than the configured threshold

#### Scenario: Threshold is never raised

- **WHEN** judgment answers indicate steady progress on every attempt
- **THEN** the task still moves to systematic debugging at the configured threshold

### Requirement: Repeated failure without progress escalates early

In enforce mode, when two consecutive assessments each judge, with probability above 0.8, that the latest two failures share a root cause and, with probability below 0.3, that the attempted fix made progress, a task that has not reached its threshold SHALL move to systematic debugging immediately. The escalation SHALL record the attempt at which it occurred and the decision record that supported it.

#### Scenario: Two stalled rounds escalate early

- **WHEN** two consecutive assessments both judge the same root cause at 0.9 and progress at 0.1 and the task has not reached its threshold
- **THEN** the task moves to systematic debugging at that attempt and the escalation records the attempt and the supporting decision

#### Scenario: One stalled round does not escalate

- **WHEN** only the latest assessment judges the same root cause and no progress
- **THEN** the task remains in ordinary repair

#### Scenario: Progress prevents escalation

- **WHEN** an assessment judges the same root cause at 0.9 but progress at 0.6
- **THEN** it does not count toward escalation

### Requirement: A failure that needs a human stops the loop

In enforce mode, an assessment that judges with probability above 0.8 that resolving the failure requires a decision, a credential, or access an automated agent cannot obtain SHALL yield a decision to await the user, with a stated reason, instead of another attempt. This SHALL take precedence over an early escalation to systematic debugging.

#### Scenario: Human-needed failure stops further attempts

- **WHEN** an assessment judges human involvement needed at 0.9
- **THEN** the decision is to await the user with a stated reason and no further attempt is made

### Requirement: Assessment needs two failures and an attempted fix

A failure SHALL be assessed only when at least two failures are recorded and the latest carries a record of the fix attempted. Otherwise no assessment SHALL be made and the loop SHALL behave as it does without judgment.

#### Scenario: First failure is not assessed

- **WHEN** only one failure has been recorded
- **THEN** no assessment is made

#### Scenario: Failure without an attempted fix is not assessed

- **WHEN** the latest failure carries no record of the attempted fix
- **THEN** no assessment is made

### Requirement: Failure state stays valid and backward compatible

A persisted failure state written without the attempted fix, assessments, or escalation SHALL remain valid and SHALL behave exactly as before. A state with an early escalation SHALL be valid only when the escalation occurred before the configured threshold, at the latest recorded failure, and the mode is systematic debugging. A state without an escalation SHALL have its mode derived from the failure count and the threshold, as before.

#### Scenario: Existing state validates unchanged

- **WHEN** a failure state written before this capability is read
- **THEN** it validates and its mode follows the failure count as before

#### Scenario: Escalation at or above the threshold is invalid

- **WHEN** a state records an early escalation at an attempt at or above the threshold
- **THEN** the state is rejected as invalid

#### Scenario: Mode without escalation still follows the count

- **WHEN** a state has no escalation and fewer failures than the threshold
- **THEN** its mode must be ordinary repair, and a state claiming systematic debugging is rejected

### Requirement: Unavailable judgment yields counting

For every unavailable reason, transitions between ordinary repair and systematic debugging SHALL follow the failure count exactly as without judgment. When judgment is disabled, no judgment work SHALL be performed.

#### Scenario: Every unavailable reason leaves transitions to the count

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, model mismatch, and a state too large to send
- **THEN** the task's mode transitions are identical to those without judgment

#### Scenario: Disabled judgment adds no work

- **WHEN** judgment is disabled
- **THEN** no request is sent, no record is written, and the loop behaves as it does without judgment

### Requirement: Shadow mode records what it would have done

In shadow mode transitions SHALL follow the failure count exactly as without judgment. The decision record SHALL hold what judgment would have decided — continue, escalate, or await the user — and SHALL be reconciled with the task's eventual outcome, so that the fairness of early escalation can be assessed.

#### Scenario: Shadow transitions follow the count

- **WHEN** judgment in shadow mode would have escalated a task early
- **THEN** the task remains in ordinary repair until the threshold and the record shows the escalation that would have occurred

#### Scenario: Outcome is recorded against the shadow decision

- **WHEN** the task later passes or exhausts its attempts
- **THEN** the shadow decision's record holds the outcome and the attempt at which it occurred

### Requirement: Failure text is redacted and bounded

Failure evidence, reproductions, and attempted-fix text SHALL be redacted before leaving the machine. The caller SHALL excerpt each evidence string to at most 2,000 bytes, each reproduction to at most 1,000 bytes, and each attempted fix to at most 2,000 bytes.

#### Scenario: Secrets in failure output are redacted

- **WHEN** failure output contains a bearer credential or a credential flag
- **THEN** it is replaced before the state is sent

#### Scenario: Long failure output is excerpted

- **WHEN** a failure's evidence exceeds 2,000 bytes
- **THEN** the state carries an excerpt within that limit

### Requirement: Thrash egress is documented

The security documentation SHALL list, for this decision, the state that leaves the machine — the latest two failures' evidence and reproductions, the attempted fix, and the task definition — and SHALL state that failure evidence may contain command output.

#### Scenario: Security documentation lists the thrash egress

- **WHEN** the security documentation's per-call-site table is read
- **THEN** it has a row for repair progress assessment naming exactly that state and noting that evidence may contain command output
