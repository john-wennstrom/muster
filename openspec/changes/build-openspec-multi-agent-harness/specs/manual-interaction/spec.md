## Purpose

Defines safe, persisted handoff to the user whenever an autonomous task reaches an action that agents must not perform or mediate.

## ADDED Requirements

### Requirement: Mandatory manual-action categories
The harness SHALL enter `awaiting_user` before secrets or authentication input, elevated permissions, destructive operations, external side effects, or a material design choice that lacks an approved answer.

#### Scenario: Command requests a password
- **WHEN** a child process requests a password, passphrase, API key, token, or device authorization interaction
- **THEN** the harness stops the affected branch without relaying the secret through an agent-visible channel

#### Scenario: Deployment would mutate an external environment
- **WHEN** a task reaches a publish, deploy, billing, remote creation, or remote mutation action
- **THEN** the harness persists a manual checkpoint before the external side effect occurs

### Requirement: Planned manual task contract
A task known to require manual action SHALL declare its category, reason, exact user instructions, expected non-secret outcome, and resume point in its `harness-task` YAML metadata.

#### Scenario: Planned manual task becomes eligible
- **WHEN** the scheduler reaches a task whose metadata declares a manual action
- **THEN** no agent attempts the action and the persisted checkpoint presents the declared instructions

### Requirement: Runtime-discovered manual checkpoint
An unplanned interactive prompt or prohibited action SHALL be converted into the same structured checkpoint as a planned manual task.

#### Scenario: Agent encounters an unexpected login
- **WHEN** a previously non-manual task discovers that authentication is required
- **THEN** the task records the detected category and safe continuation instructions and transitions to `awaiting_user`

### Requirement: Persisted checkpoint record
An `awaiting_user` checkpoint SHALL record run, change, task, DAG branch, category, reason, sanitized instructions, created time, status, and resume target atomically. It SHALL NOT contain secret values.

#### Scenario: Harness restarts while paused
- **WHEN** the process restarts with an unresolved manual checkpoint
- **THEN** status still reports the same blocked branch and instructions without rerunning the triggering action

### Requirement: Affected-branch pause
Entering `awaiting_user` SHALL stop dispatch and mutation on the affected task and every dependent task. Independent DAG branches MAY continue if their permissions, dependencies, and writer lease allow it.

#### Scenario: Independent branch remains ready
- **WHEN** one branch waits for user authentication and a separate branch has no dependency on it
- **THEN** the scheduler may continue the independent branch while clearly reporting the paused branch

### Requirement: Pi user notification
The active Pi session SHALL display a prominent notification containing the change, task, reason, safe instructions, and resume command when a manual checkpoint is created or restored.

#### Scenario: Manual checkpoint is created
- **WHEN** a task enters `awaiting_user`
- **THEN** the Pi UI notifies the user and status continues to expose the unresolved checkpoint

### Requirement: Explicit confirmation resume
Only an explicit user `/change resume <change> <checkpoint>` confirmation SHALL resolve a manual checkpoint. The harness SHALL record who confirmed and when, and SHALL resume from the recorded target without asking the model to inspect secret material.

#### Scenario: User confirms completion
- **WHEN** the user invokes resume for the active checkpoint
- **THEN** the checkpoint is marked confirmed and the affected branch becomes eligible according to its existing dependencies and gates

#### Scenario: No confirmation arrives
- **WHEN** a checkpoint remains unresolved across timeout or restart
- **THEN** it remains paused and is never auto-confirmed, skipped, or treated as success