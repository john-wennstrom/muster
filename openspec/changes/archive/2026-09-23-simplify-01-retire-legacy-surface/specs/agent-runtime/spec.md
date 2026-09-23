## ADDED Requirements

### Requirement: One child-agent entry point

Production code that runs a model in a child process SHALL do so through a single entry point that offers a read-only mode and a brokered writer mode. No other module in the source tree SHALL spawn a Pi child process. Entry point names SHALL NOT describe the code as legacy.

#### Scenario: A read-only agent uses the entry point

- **WHEN** exploration, planning, planning review or task review runs a model
- **THEN** the child is started through the single entry point in read-only mode

#### Scenario: A builder uses the same entry point as a writer

- **WHEN** a builder task runs a model
- **THEN** the child is started through the same entry point in writer mode, receiving the task's declared scopes, its writer lease and its judgment hook

#### Scenario: No second spawn path exists

- **WHEN** the source tree is searched for code that launches the Pi executable
- **THEN** exactly one module does so

### Requirement: The source tree does not depend on retired code

No module under the source tree SHALL import from the retired extension directory. The model stack, the agent run record and the child runtime resolution SHALL live under the source tree, and the extension directory SHALL NOT exist.

#### Scenario: No import reaches the extension directory

- **WHEN** every import in the source tree is resolved
- **THEN** none resolves to a path under the extension directory

#### Scenario: Model stack loading is unchanged

- **WHEN** a model-stack YAML file that loaded before this change is loaded after it
- **THEN** it produces the same slots, primary builder and architect

### Requirement: Agent progress presentation is owned by the change surface

The live agent columns shown while `/change` runs agents SHALL be implemented under the change surface and SHALL NOT depend on code that renders panels for retired commands.

#### Scenario: Progress renders without the extension

- **WHEN** a `/change` command starts two agents
- **THEN** their live columns render using only code under the source tree
