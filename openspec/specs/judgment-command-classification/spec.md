# judgment-command-classification Specification

## Purpose

Defines how brokered host commands are checked for manual-approval categories: the existing rules remain an unchanged floor, and typed judgment can only add a category for commands the rules and profile would otherwise allow.

## Requirements

### Requirement: The existing rules are a floor

A command that the existing rules classify as needing manual approval, or that the version-control allowlist or the command profile refuses, SHALL be refused exactly as it is without judgment, whatever judgment would answer, and SHALL NOT be sent for judgment.

#### Scenario: Rule-denied command is denied without judgment

- **WHEN** a command matches an existing manual-approval rule and judgment is enabled
- **THEN** the command is denied with the rule's category and no judgment request is sent

#### Scenario: Judgment answering none cannot allow a rule-denied command

- **WHEN** a command is refused by a rule and a judgment double answers none with full confidence for every command
- **THEN** the command is still refused

### Requirement: Judgment can only add a manual category

For a command that the rules and profile would allow, a judged category other than none SHALL be handled exactly as a rule-produced category is handled in that path — denied in the brokered runner, and raised as a persisted manual checkpoint in the controller path — and SHALL be tagged as judged. No judgment answer SHALL relax, remove, or bypass any check.

#### Scenario: Judged category denies a command the rules allow

- **WHEN** a command passes the rules and profile and judgment in enforce mode answers external side effect
- **THEN** the command is denied with that category and does not start

#### Scenario: Judged category is tagged as judged

- **WHEN** a command is denied on a judged category
- **THEN** the denial identifies the category's source as judgment and carries the judged confidence

### Requirement: None and unavailable proceed as today

A command judged as needing no manual approval SHALL proceed exactly as it does without judgment. A command whose judgment is unavailable for any reason SHALL proceed exactly as it does without judgment. A judged none below 0.7 confidence SHALL be recorded for calibration. When judgment is disabled, no judgment work SHALL be performed.

#### Scenario: Judged none proceeds

- **WHEN** judgment answers none for a command that passes the rules and profile
- **THEN** the command proceeds and is executed and audited as it is without judgment

#### Scenario: Unavailable judgment proceeds

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, and model mismatch
- **THEN** the command proceeds as it does without judgment

#### Scenario: Uncertain none is logged

- **WHEN** judgment answers none with confidence below 0.7
- **THEN** the command proceeds and the record is marked for calibration

#### Scenario: Disabled judgment adds no work

- **WHEN** judgment is disabled
- **THEN** no request is sent, no record is written, and the command path behaves as it does without judgment

### Requirement: An uncertain category still adds caution

A judged category other than none SHALL add its manual-approval requirement at any confidence.

#### Scenario: Low-confidence category still denies

- **WHEN** judgment in enforce mode answers destructive with confidence 0.4
- **THEN** the command is denied with the destructive category

### Requirement: Shadow mode records without blocking

In shadow mode every command SHALL proceed exactly as it does without judgment. The record SHALL hold the judged category and confidence, and the decision summary SHALL report by category how many commands would have been stopped.

#### Scenario: Shadow judgment never blocks

- **WHEN** judgment in shadow mode answers a manual category for a command that passes the rules and profile
- **THEN** the command proceeds and the record shows it would have been stopped

### Requirement: Commands under read-only restrictions are not judged

Commands run under the read-only profile, and version-control commands whose subcommand is on the read-only allowlist, SHALL NOT be sent for judgment.

#### Scenario: Read-only git command is not judged

- **WHEN** a command runs a read-only version-control subcommand
- **THEN** no judgment request is sent for it

### Requirement: Judgment latency is bounded

Judging one command SHALL have a deadline of at most 1.5 seconds, after which the command proceeds as without judgment. A repeat of an identical command within a run SHALL reuse the earlier classification instead of sending a new request. An unavailable result SHALL NOT be reused.

#### Scenario: Slow judgment does not delay a command beyond its deadline

- **WHEN** the judgment service does not answer within the deadline
- **THEN** the command proceeds no later than the deadline

#### Scenario: Identical command reuses the classification

- **WHEN** the same profile, executable, arguments, and working directory are judged twice in one run
- **THEN** only one request is sent

### Requirement: Only the command shape is sent

The state sent for judgment SHALL consist of the executable, the arguments with secret patterns redacted, the working directory relative to the worktree, and the command profile. It SHALL NOT include the environment or the content of any file.

#### Scenario: State holds only the command shape

- **WHEN** a command is sent for judgment
- **THEN** the state holds exactly the executable, the redacted arguments, the relative working directory, and the profile, and a credential flag's value is replaced

### Requirement: The checkpoint path receives the same classification

Where the controller raises a persisted manual checkpoint for a runtime action, a judged category SHALL produce the same checkpoint that a rule-produced category produces.

#### Scenario: Judged category raises a checkpoint

- **WHEN** the controller guards a runtime command that passes the rules and judgment in enforce mode answers authentication
- **THEN** a pending manual checkpoint of the authentication category is persisted and the command is not executed

### Requirement: Judged decisions are audited

Each judged command's decision — category, confidence, mode, and whether it stopped the command — SHALL be recorded, and a command stopped on a judged category SHALL be visible as judged in the host audit event.

#### Scenario: Denied command's audit event names judgment

- **WHEN** a command is denied on a judged category
- **THEN** the host audit event records the denial and identifies it as judged

### Requirement: Security guarantees hold whatever judgment answers

The brokered runner's existing guarantees — path checks, the writer-lease requirement for source mutation, the executable allowlist, environment minimization, output and timeout limits, and the post-command repository audit — SHALL hold for every judgment answer, including answers to commands whose arguments were crafted to steer the judgment.

#### Scenario: Guarantees hold when judgment answers none for everything

- **WHEN** the existing adversarial cases run with a judgment double that answers none for every command
- **THEN** every case has the same outcome it has without judgment

#### Scenario: Guarantees hold when judgment answers a category for everything

- **WHEN** the existing adversarial cases run with a judgment double that answers a manual category for every command
- **THEN** every case is either denied or has the same outcome it has without judgment, and none is more permitted

#### Scenario: Manipulated argument content cannot relax anything

- **WHEN** a command's arguments contain text written to steer the judgment toward none
- **THEN** no rule, profile, or allowlist decision is relaxed

### Requirement: Command egress is documented

The security documentation SHALL list, for this decision, the state that leaves the machine — the executable, the redacted arguments, the relative working directory, and the profile — and SHALL describe judged categories as an addition to the existing preflight checks.

#### Scenario: Security documentation lists the command egress

- **WHEN** the security documentation is read
- **THEN** its per-call-site table has a row for command classification naming exactly that state, and its description of preflight checks mentions judged categories
