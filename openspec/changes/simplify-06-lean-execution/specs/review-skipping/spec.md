## ADDED Requirements

### Requirement: A task review is skipped only when every guard holds

A task's review SHALL be skipped only when all of the following hold: judgment is in enforce mode; the lane policy permits work reduction; every focus question was answered with confidence and with its good value, so no focus item speaks and none is uncertain; the task's verification passed; its test-first evidence was accepted; the diff excerpt was complete and every changed path is inside the task's write scope and none is denylisted; and this is the task's first attempt. If any guard fails the reviewer SHALL run exactly as it does without skipping.

#### Scenario: Every guard holds

- **WHEN** a first-attempt task on the medium lane has passing verification, accepted test-first evidence, an in-scope complete diff, and confidently good answers to every focus question in enforce mode
- **THEN** no reviewer session starts for the task

#### Scenario: One answer is uncertain

- **WHEN** every focus answer is good but one is uncertain
- **THEN** the reviewer runs

#### Scenario: A changed path is outside scope

- **WHEN** the diff changes a path outside the task's write scope
- **THEN** the reviewer runs

#### Scenario: A retry is always reviewed

- **WHEN** a task's second attempt completes
- **THEN** the reviewer runs

### Requirement: The large lane never skips a review

A task on the large lane SHALL always be reviewed, whatever judgment answers.

#### Scenario: Large lane

- **WHEN** a task on the large lane would otherwise satisfy every guard
- **THEN** the reviewer runs

### Requirement: Shadow mode and unavailable judgment never skip

In shadow mode the reviewer SHALL run and the record SHALL note that the review would have been skipped. When judgment is disabled or unavailable the reviewer SHALL run.

#### Scenario: Shadow records the would-have-skipped

- **WHEN** every guard holds except that judgment is in shadow mode
- **THEN** the reviewer runs and the decision record shows the review would have been skipped

#### Scenario: Unavailable judgment

- **WHEN** the focus request cannot be answered
- **THEN** the reviewer runs

### Requirement: A skipped review is recorded as skipped

A skipped review SHALL be persisted as a review record with an approving verdict, the model named as skipped, the basis judgment, and the identifier of the judgment record that decided it. It SHALL NOT be recorded as a reviewer approval.

#### Scenario: The record is labelled

- **WHEN** a review is skipped
- **THEN** the review record has basis judgment, model skipped and the decision record identifier

#### Scenario: A reviewer approval is unchanged

- **WHEN** a reviewer approves a task
- **THEN** the review record has the reviewer basis and the reviewer's model

### Requirement: Final validation accepts a skipped review only under the lane's permission

The evidence gate of final validation SHALL accept a review record whose basis is judgment only when the run manifest's lane permits work reduction and the record names a judgment record identifier. Otherwise the gate SHALL fail and name the task.

#### Scenario: A permitted skip

- **WHEN** a medium-lane task has a judgment-basis review record naming its decision record
- **THEN** the evidence gate passes for that task

#### Scenario: A skip on the large lane

- **WHEN** a large-lane task has a judgment-basis review record
- **THEN** the evidence gate fails naming the task

#### Scenario: A skip without a decision record

- **WHEN** a judgment-basis review record names no decision record
- **THEN** the evidence gate fails naming the task

### Requirement: The run manifest records the lane

The run manifest SHALL record the change's lane when it is created and SHALL update it when the change is escalated.

#### Scenario: Manifest carries the lane

- **WHEN** implementation creates a run manifest for a small-lane change
- **THEN** the manifest records the lane small
