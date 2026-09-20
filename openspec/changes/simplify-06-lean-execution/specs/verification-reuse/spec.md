## ADDED Requirements

### Requirement: Current task evidence is reused

At verify, a task's verification commands SHALL be skipped when its persisted result records each command with exit code zero and its recorded source digest equals the current source digest. Commands that do not meet both conditions SHALL run. The full test suite SHALL always run.

#### Scenario: Unchanged source reuses evidence

- **WHEN** the current source digest equals the digest recorded when a task's commands passed
- **THEN** those commands are not run again and the full suite still runs

#### Scenario: Changed source reruns

- **WHEN** the source has changed since a task's commands passed
- **THEN** that task's commands run again

### Requirement: Reused evidence is labelled

The verification artifact SHALL mark each reused command as reused, with the source digest it was recorded against.

#### Scenario: The artifact marks reuse

- **WHEN** a command's evidence is reused
- **THEN** the verification artifact lists it as reused with the digest
