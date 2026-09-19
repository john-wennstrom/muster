## Purpose

Defines how a builder task may be routed to an explicitly configured economy model when a typed judgment confidently finds it mechanical and low-risk, and the guards that keep every other task on the primary builder.

## ADDED Requirements

### Requirement: Routing is opt-in and inert without an economy lane

Task routing SHALL run only when its own enabling flag is set, judgment is enabled, and an economy model is configured. Without any of the three, every builder task SHALL use the primary builder exactly as it does without judgment, and no request SHALL be sent on routing's account.

#### Scenario: No economy model means no routing

- **WHEN** routing is enabled and judgment is enabled but no economy model is configured
- **THEN** every task uses the primary builder and no routing request is sent

#### Scenario: No flag means no routing

- **WHEN** an economy model is configured and judgment is enabled but the routing flag is not set
- **THEN** every task uses the primary builder and no routing request is sent

### Requirement: The economy lane is explicit configuration

The economy model SHALL be configured only through its documented environment override and resolved by the same model-selection rules as the other roles. The harness SHALL NOT infer, default, or choose an economy model itself. The economy lane SHALL inherit the primary builder's thinking level, prompts, and tool configuration, and differ from it only in the model.

#### Scenario: Economy lane resolves from its override

- **WHEN** the economy override names a model
- **THEN** the economy lane uses that model

#### Scenario: Economy lane inherits the primary builder's configuration

- **WHEN** a task is routed to the economy lane
- **THEN** its thinking level, prompts, and tool configuration equal the primary builder's

#### Scenario: Absent override yields no lane

- **WHEN** the economy override is not set
- **THEN** no economy lane exists and the primary builder's model is whatever it resolves to without judgment

### Requirement: A task is downgraded only when every guard holds

A task SHALL be routed to the economy lane only when all of the following hold: it is judged mechanical with probability above 0.8; each of needing deep reasoning, needing a large context, requiring a novel design, changing a security boundary, and changing a public contract is judged below 0.3; its reach is judged below 1.5 with confidence of at least 0.8; and it is on its first attempt. Otherwise it SHALL use the primary builder.

#### Scenario: Mechanical low-risk task is routed to the economy lane

- **WHEN** a first-attempt task is judged mechanical at 0.9, every risk below 0.2, and its reach below 1.5 at confidence 0.9, in enforce mode
- **THEN** the task runs on the economy lane

#### Scenario: Security-boundary task stays on the primary builder

- **WHEN** a task is judged to change a security boundary at 0.5
- **THEN** the task runs on the primary builder

#### Scenario: Public-contract task stays on the primary builder

- **WHEN** a task is judged to change a public contract at 0.5
- **THEN** the task runs on the primary builder

#### Scenario: Wide-reach task stays on the primary builder

- **WHEN** a task's reach is judged at 2.0
- **THEN** the task runs on the primary builder

#### Scenario: Uncertain answer stays on the primary builder

- **WHEN** any single guard's answer lies inside its uncertain band
- **THEN** the task runs on the primary builder

### Requirement: Retries never downgrade

A task on its second or later attempt SHALL use the primary builder, whichever lane its earlier attempts used.

#### Scenario: Retried task uses the primary builder

- **WHEN** a task that ran on the economy lane is attempted again
- **THEN** the retry runs on the primary builder and no routing request is sent for it

### Requirement: Unavailable judgment yields today's routing

For every unavailable reason, every task SHALL use the primary builder. When judgment is disabled, no routing work SHALL be performed.

#### Scenario: Every unavailable reason uses the primary builder

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, and model mismatch
- **THEN** the task runs on the primary builder exactly as without judgment

#### Scenario: Disabled judgment adds no work

- **WHEN** judgment is disabled
- **THEN** no request is sent, no record is written, and the builder step behaves as it does without judgment

### Requirement: Shadow mode routes nothing and measures

In shadow mode every task SHALL use the primary builder. The decision record SHALL hold the lane that would have been chosen and the result of each guard. A report SHALL give, for tasks that would have been routed, the share that completed on their first attempt, and, for enforce runs, the same share for each lane.

#### Scenario: Shadow routing is unchanged

- **WHEN** judgment runs in shadow mode with answers that would have routed a task to the economy lane
- **THEN** the task runs on the primary builder and the record shows the economy lane would have been chosen

#### Scenario: Success rate is reported per lane

- **WHEN** the records of several enforce-mode runs are summarized
- **THEN** the report gives, for each lane, the number of tasks and the share that completed on their first attempt

### Requirement: Routing decisions are recorded per task and reconciled

Each routing decision SHALL be recorded with the task, the lane chosen, and each guard's result, and SHALL be reconciled with the task's first-attempt outcome.

#### Scenario: Task outcome is recorded against its lane

- **WHEN** a routed or shadow-decided task's pipeline finishes its first attempt
- **THEN** the routing record holds the lane and the task's outcome

### Requirement: Only the task contract is sent

The state sent for judgment SHALL consist of the task's description, requirements, scenarios, read and write scopes, and verification commands. It SHALL NOT include source code or file content.

#### Scenario: State holds only the task contract

- **WHEN** a task is sent for judgment
- **THEN** the state holds exactly the task's description, requirements, scenarios, scopes, and verification commands

### Requirement: Routing egress and configuration are documented

The security documentation SHALL list, for this decision, the state that leaves the machine, and the project documentation SHALL describe the routing flag and the economy model override, stating that the economy lane exists only when configured.

#### Scenario: Documentation lists the routing egress and configuration

- **WHEN** the documentation is read
- **THEN** the per-call-site table has a row for task routing naming exactly that state, and the routing flag and economy override are described
