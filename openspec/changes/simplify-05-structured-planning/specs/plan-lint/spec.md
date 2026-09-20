## ADDED Requirements

### Requirement: Lint runs before any reviewer

Review SHALL first run a deterministic lint over the change's artifacts on disk, on every lane, and SHALL end blocked with the complete list of failures, without dispatching any reviewer or judgment request, when any check fails.

#### Scenario: A lint failure blocks without a reviewer

- **WHEN** review runs and a task cites a scenario that no specification contains
- **THEN** the command is blocked with the failure listed, and no reviewer and no judgment request is made

### Requirement: Lint checks are deterministic and complete

Lint SHALL check that: the artifacts exist and parse and OpenSpec strict validation passes; tasks validate and every requirement and scenario reference resolves against the change's real specification files; every scenario is cited by at least one task and every task cites a requirement, a scenario and at least one verification command; verification commands parse and use an executable the verification profile allows; no write scope matches the credential denylist or the version-control directory; and the dependency graph is acyclic.

#### Scenario: References resolve against real specifications

- **WHEN** a hand-edited task cites a requirement that no specification file in the change contains
- **THEN** lint fails naming the task and the requirement

#### Scenario: A credential file in a write scope

- **WHEN** a task's write scope names an environment file
- **THEN** lint fails naming the task and the scope

#### Scenario: An uncovered scenario

- **WHEN** no task cites a scenario that a specification defines
- **THEN** lint fails naming the scenario

### Requirement: Lane limits escalate instead of failing

The lane policy SHALL declare a task limit, whether manual tasks are allowed, and the plan review mode for each lane. A plan that violates the small lane's limits SHALL escalate the change to medium with the violation as the reason, rather than fail lint.

#### Scenario: Too many tasks for small

- **WHEN** a small-lane plan has more tasks than the lane allows
- **THEN** the change is escalated to medium and the reviewer runs

#### Scenario: A manual task on the small lane

- **WHEN** a small-lane plan contains a manual task
- **THEN** the change is escalated to medium

### Requirement: The small lane is approved by lint and a semantic check

On the small lane, after deterministic lint passes, one `plan.lint` judgment request SHALL ask the six task-quality concerns (verification, scope, atomicity, dependencies, size and coverage) over the task list and requirement text. A clean, confident answer, or judgment being unavailable, SHALL approve the plan by lint without dispatching a reviewer. Any confident finding, or any uncertain concern, SHALL escalate the change to medium and run the reviewer with the findings as unverified notes.

#### Scenario: A clean small plan is approved without a reviewer

- **WHEN** lint passes and the semantic check answers cleanly and confidently
- **THEN** review.md records an approving lint review and no reviewer session starts

#### Scenario: A finding escalates

- **WHEN** the semantic check confidently reports that a task is too large
- **THEN** the change is escalated to medium and the reviewer runs with the finding as a note

#### Scenario: An uncertain concern escalates

- **WHEN** the semantic check is uncertain about one concern
- **THEN** the change is escalated to medium

#### Scenario: Unavailable judgment does not escalate

- **WHEN** the semantic check cannot be answered
- **THEN** the plan is approved by lint alone and the record states that the semantic check did not run

### Requirement: Medium and large lanes keep the reviewer

On the medium and large lanes the reviewer SHALL run after lint. Findings from the semantic check SHALL reach the reviewer only as unverified notes and SHALL NOT change any verdict or any review field.

#### Scenario: Findings are notes only

- **WHEN** a medium-lane review runs and the semantic check reports a finding
- **THEN** the reviewer's prompt lists the finding as unverified and the verdict comes from the reviewer alone

### Requirement: Lint approvals are recorded honestly

A review artifact SHALL carry its mode, reviewer or lint. A lint approval SHALL record the checks that ran and the judged answers, SHALL name lint as its model, and SHALL NOT claim that any model read the artifacts. Review artifacts with no mode SHALL be read as reviewer reviews.

#### Scenario: A lint approval names lint

- **WHEN** a plan is approved by lint
- **THEN** review.md has mode lint, model lint, the checks that ran, and an approving verdict bound to the artifact digest

#### Scenario: An older review file

- **WHEN** a review artifact without a mode is read
- **THEN** it is treated as a reviewer review

### Requirement: A lint approval is current only on the small lane

A lint approval SHALL count as a current review only while the change's lane is small and the artifact digest matches. After an escalation the change SHALL require review again, and that review SHALL dispatch the reviewer.

#### Scenario: Escalation invalidates a lint approval

- **WHEN** a change with a lint approval is escalated to medium
- **THEN** its lifecycle requires review and the next review dispatches the reviewer

### Requirement: The semantic check state is bounded and excerpted

The `plan.lint` state SHALL contain an excerpt of the change summary of at most 2,000 bytes, the requirement and scenario text excerpted to fit with every name kept, and each task's description, dependencies, scopes and verification commands. A task list with more than 40 tasks or a state over the service's limits SHALL NOT be sent, and the plan SHALL follow the medium path.

#### Scenario: Too many tasks

- **WHEN** a plan has more than 40 tasks
- **THEN** no semantic request is sent and the change is escalated to medium

### Requirement: Semantic findings are generated by code

Findings SHALL be fixed templates filled in by code from the answers, and the judgment service SHALL write no text that reaches a user or a reviewer.

#### Scenario: A finding is a template

- **WHEN** the semantic check reports a scope concern for a task
- **THEN** the finding text is the template for the scope concern naming the task

### Requirement: Semantic check egress is documented

The security documentation SHALL contain one call-site row for `plan.lint` naming the state it sends, and SHALL NOT contain a row for the removed task-quality decision.

#### Scenario: One row replaces one

- **WHEN** the security documentation's call-site table is read
- **THEN** it has a `plan.lint` row and no task-quality row
