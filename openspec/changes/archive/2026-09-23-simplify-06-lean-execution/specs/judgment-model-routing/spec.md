## REMOVED Requirements

### Requirement: The economy lane is explicit configuration
**Reason**: The economy lane no longer inherits the primary builder's thinking level; thinking is chosen per task, and a reviewer economy model is added.
**Migration**: See "Economy models are explicit configuration" and "Thinking is chosen per task".

## ADDED Requirements

### Requirement: Economy models are explicit configuration

The builder economy model and the reviewer economy model SHALL each be configured only through their own documented environment override and resolved by the same model-selection rules as the other roles. The harness SHALL NOT infer, default or choose either model itself. An economy lane SHALL inherit the primary role's prompts and tool configuration and differ from it in the model, and its thinking level SHALL be the level chosen for the task.

#### Scenario: Each override resolves independently

- **WHEN** only the builder economy override is set
- **THEN** economy builder tasks use it and reviewers use the primary reviewer

#### Scenario: Economy lane inherits prompts and tools

- **WHEN** a task is routed to an economy lane
- **THEN** its prompts and tool configuration equal the primary role's

#### Scenario: Absent override yields no lane

- **WHEN** an economy override is not set
- **THEN** no lane exists for that role and the primary model is used

### Requirement: Thinking is chosen per task

The routing decision SHALL also choose the builder's and the reviewer's thinking level for a task before its first attempt. A task judged mechanical, with every risk confidently absent and confidently narrow reach, SHALL get thinking low for the builder and medium for the reviewer. A mechanical task with moderate reach SHALL get medium for the builder and high for the reviewer. Every other task, every uncertain answer, every retry and every task on the large lane SHALL keep the configured builder thinking and high for the reviewer. No level SHALL be below low.

#### Scenario: A mechanical narrow task

- **WHEN** routing confidently finds a task mechanical, risk-free and narrow in enforce mode on a medium lane
- **THEN** the builder runs at thinking low and the reviewer at medium

#### Scenario: An uncertain task keeps configured thinking

- **WHEN** one risk answer is uncertain
- **THEN** the builder keeps its configured thinking and the reviewer runs at high

#### Scenario: A retry keeps configured thinking

- **WHEN** a task is attempted a second time
- **THEN** the builder uses its configured thinking and the primary model

#### Scenario: The large lane never lowers thinking

- **WHEN** a task on the large lane would otherwise qualify
- **THEN** the builder keeps its configured thinking and the reviewer runs at high

### Requirement: One routing request serves builder and reviewer

At most one routing request SHALL be sent per task, before its first attempt, and its verdict SHALL be used for the builder and the reviewer of that task.

#### Scenario: One request per task

- **WHEN** a task is built and reviewed
- **THEN** exactly one routing request was sent for it
