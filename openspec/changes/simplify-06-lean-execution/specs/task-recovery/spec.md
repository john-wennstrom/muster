## ADDED Requirements

### Requirement: Every failed attempt is recorded

After any task attempt that does not complete, the harness SHALL record the attempt number, the outcome, excerpts of the failure evidence of at most 2,000 bytes each, the reproduction (the failing verification command with its exit code and an output tail of at most 1,000 bytes), the builder's stated fix, and the changed paths, keeping the two latest records for the task. Records SHALL be redacted and bounded like other judgment state.

#### Scenario: A verification failure is recorded

- **WHEN** a task's verification command exits non-zero
- **THEN** a failure record holds the command, its exit code, an output tail of at most 1,000 bytes and the changed paths

#### Scenario: Only the latest two are kept

- **WHEN** a task fails three times
- **THEN** the two latest failure records remain

### Requirement: The next attempt starts informed

The builder prompt SHALL include the task's latest failure record as an optional block when one exists, on an automatic retry and on a later invocation of the implement command alike, and SHALL NOT include a block when none exists.

#### Scenario: A retry sees the failure

- **WHEN** a task is attempted again after a recorded failure
- **THEN** the builder prompt contains the failure evidence and reproduction

#### Scenario: A first attempt has no block

- **WHEN** a task has no failure record
- **THEN** the builder prompt contains no failure block

### Requirement: A decision chooses retry, escalate or stop

After a failed attempt, one `task.recovery` judgment request SHALL choose among retry (the failure is a fixable defect in the attempt), escalate (the failure shows the change is broader or harder than its lane) and stop (the failure needs a person, such as an environment problem, a missing credential or an ambiguous requirement). Only a confident answer SHALL act. The decision SHALL NOT add an attempt beyond the scheduler's limit of two attempts.

#### Scenario: Retry within the limit

- **WHEN** the first attempt of a task is blocked by failed verification and the decision confidently answers retry in enforce mode
- **THEN** a second attempt runs with the primary configuration and the failure in its prompt

#### Scenario: Retry never exceeds the limit

- **WHEN** the second attempt fails and the decision answers retry
- **THEN** no third attempt runs

#### Scenario: Escalate promotes the lane

- **WHEN** the decision confidently answers escalate for a small-lane change
- **THEN** the lane becomes medium, the command ends blocked naming the reason, and its next command is review

#### Scenario: Stop ends the run for the task

- **WHEN** the decision confidently answers stop
- **THEN** the task is not retried and the command ends blocked with the reason and the failure record path

### Requirement: Without judgment behavior is as before

When judgment is disabled, unavailable, in shadow mode or uncertain, a thrown attempt SHALL be retried up to the scheduler's limit and a blocked outcome SHALL be final for the run, exactly as before this change. Shadow mode SHALL record what the decision would have done.

#### Scenario: Unavailable judgment

- **WHEN** the recovery request cannot be answered after a blocked outcome
- **THEN** the task ends blocked with no retry

#### Scenario: Shadow records the alternative

- **WHEN** the decision would have answered retry in shadow mode
- **THEN** the task ends blocked and the record shows retry as the answer it would have given

### Requirement: Recovery egress is documented

The security documentation SHALL contain one call-site row for `task.recovery` naming the failure state it sends, and SHALL NOT contain a row for the removed thrash decision.

#### Scenario: One row replaces one

- **WHEN** the security documentation's call-site table is read
- **THEN** it has a `task.recovery` row and no thrash row

### Requirement: The unconnected repair policies are removed

The debugging policy and the repair-progress policy SHALL NOT exist in the source tree.

#### Scenario: The modules are gone

- **WHEN** the source tree is listed
- **THEN** neither policy module is present
