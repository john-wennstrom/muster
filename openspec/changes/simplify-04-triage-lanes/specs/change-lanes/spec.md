## ADDED Requirements

### Requirement: Every change has exactly one lane

Every change SHALL have exactly one lane, one of small, medium or large, recorded with the change's run records when planning chooses it. The record SHALL state the lane, its source (user, judgment or pattern), the reasons that decided it, and its escalation history. A change with no lane record SHALL be treated as medium.

#### Scenario: Planning records the lane

- **WHEN** propose or refine chooses a lane
- **THEN** the change's run records hold the lane, its source, the deciding reasons and an empty escalation history

#### Scenario: A change planned before lanes existed

- **WHEN** a change has no lane record
- **THEN** every phase treats it as medium

### Requirement: Lanes only escalate

A lane SHALL only move upward, from small to medium or large and from medium to large, and every move SHALL be appended to the escalation history with its reason and time. An attempt to move a change to the same or a lower lane SHALL be refused.

#### Scenario: Escalation is recorded

- **WHEN** a change is escalated from small to medium
- **THEN** the lane becomes medium and the history holds the previous lane, the new lane, the reason and the time

#### Scenario: A downgrade is refused

- **WHEN** a change on the large lane is asked to move to medium
- **THEN** the request is refused and the lane and history are unchanged

### Requirement: The user may choose the lane

Propose and refine SHALL accept a lane argument naming small, medium or large, written as the word `lane=` followed by the name, immediately after the change name. It SHALL be an ordinary command argument and SHALL NOT be a launch flag. An explicit lane SHALL override triage, SHALL be recorded with source user, and SHALL cause no triage request to be sent. An unrecognized lane value SHALL block the command with its usage line and SHALL NOT be sent to any model.

#### Scenario: An explicit lane overrides triage

- **WHEN** propose is invoked with the argument `lane=small` after the change name
- **THEN** the lane is small with source user and no triage request is sent

#### Scenario: A goal that starts with a lane name is not a lane

- **WHEN** propose is invoked with a goal beginning with the word small and no `lane=` argument
- **THEN** the goal is passed through unchanged and triage chooses the lane

#### Scenario: An invalid lane is rejected

- **WHEN** propose is invoked with a lane value that is not one of the three names
- **THEN** the command is blocked with its usage line and no agent or judgment request is made

### Requirement: Lane policy is one declared table

The behavior that depends on a lane SHALL be read from a single declared policy table keyed by lane, and no phase SHALL branch on the lane by any other means. The table SHALL state for each lane the number of specialist opinions, whether a debate runs, and whether decisions that reduce work are permitted, with large permitting none.

#### Scenario: Large adds opinions and a debate

- **WHEN** planning runs on the large lane and the optional budget is available
- **THEN** at least two specialist opinions and a debate run before synthesis

#### Scenario: Small and medium run no optional stages

- **WHEN** planning runs on the small or medium lane
- **THEN** no specialist opinion and no debate run

#### Scenario: Large never permits work reduction

- **WHEN** a decision that reduces work asks the policy table about the large lane
- **THEN** the answer is that reduction is not permitted

### Requirement: No agent session is needed to choose a lane

The lane SHALL be chosen and recorded before any model agent session starts in propose or refine. Choosing it SHALL use code retrieval, code pattern classification and, when available, one judgment request.

#### Scenario: Lane precedes the first agent

- **WHEN** propose runs on a repository with judgment unavailable
- **THEN** the lane record is written before any agent child process is started

### Requirement: The lane is visible

The change status output SHALL show the lane, its source and the number of escalations.

#### Scenario: Status shows the lane

- **WHEN** status is requested for a change whose lane was chosen by judgment and escalated once
- **THEN** the output names the lane, the source judgment and one escalation
