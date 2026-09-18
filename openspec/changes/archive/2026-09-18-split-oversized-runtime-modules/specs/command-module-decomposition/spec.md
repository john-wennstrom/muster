## Purpose

Defines the decomposition contract for the `/change` surface's orchestration and dispatch modules: what a single module may own, and the requirement that each agent-invocation step be independently addressable and testable.

## ADDED Requirements

### Requirement: Independently addressable agent-invocation steps

Each agent-invocation step of an implementation task — producing the implementation, running its verification, and reviewing its result — SHALL be an independently addressable unit that accepts its inputs explicitly rather than capturing surrounding run state. Each step SHALL be invocable and assertable without executing a complete task run.

#### Scenario: A single step is exercised

- **WHEN** one agent-invocation step is exercised with explicit inputs
- **THEN** it performs that step and returns its result without requiring a scheduler, a task graph, a worktree selection, or a full run to be driven

#### Scenario: A step is substituted

- **WHEN** one step is replaced for a run
- **THEN** the remaining steps and the orchestration are unaffected and require no change

#### Scenario: A step's inputs are inspected

- **WHEN** a step's declaration is read
- **THEN** everything it depends on is visible in its inputs, and it reads no state from an enclosing orchestration scope

### Requirement: Single-responsibility dispatch modules

Command-line parsing, dispatch to handlers, outcome rendering, failure classification, and host registration SHALL each be owned by a separate module. No module SHALL own more than one of these responsibilities.

#### Scenario: Failure classification is changed

- **WHEN** the classification of a failure is changed
- **THEN** only the classification module is modified, and parsing, dispatch, rendering, and registration are untouched

#### Scenario: Rendering is changed

- **WHEN** the presentation of an outcome is changed
- **THEN** only the rendering module is modified

#### Scenario: Public surface is consumed

- **WHEN** a consumer uses the dispatch surface after the split
- **THEN** the exported entry points it depends on are unchanged

### Requirement: Concerns are owned by their layer

Behavior that belongs to another layer SHALL NOT be embedded in an orchestration module. Command parsing for verification belongs to the execution layer, persisted record reading belongs to the persistence layer, and adapting a validated task into a collaboration task belongs beside the collaboration type it produces.

#### Scenario: A second consumer needs an embedded concern

- **WHEN** a module outside the orchestration needs one of these behaviors
- **THEN** it depends on the owning layer and not on the orchestration module

#### Scenario: Orchestration module is read

- **WHEN** the orchestration module is read
- **THEN** it orchestrates a run and does not define command parsing, record schemas unrelated to its own results, or type adapters for other layers

### Requirement: Decomposition preserves behavior

The decomposition SHALL NOT change command grammar, outcome statuses, blocker categories, persisted record formats, or the extension entry point.

#### Scenario: Run is executed after decomposition

- **WHEN** an implementation run is executed after the split
- **THEN** it produces the same persisted records, task outcomes, and reported result as before

#### Scenario: Command is invoked after decomposition

- **WHEN** any advertised action is invoked after the split
- **THEN** it is parsed, dispatched, rendered, and registered exactly as before
