## ADDED Requirements

### Requirement: Planning returns a typed plan

The planning session SHALL return a typed plan rather than artifact text. A plan SHALL be one of three dispositions: a plan (summary, rationale, listed changes, capabilities, requirements with named scenarios, an optional design, and tasks with full metadata), a request for clarification carrying a question, or a report that the request is already satisfied with evidence paths. The description of the plan's shape given to the session SHALL be generated from the same schema the plan is validated against.

#### Scenario: A plan is parsed

- **WHEN** the session returns a well-formed plan
- **THEN** it is parsed into typed requirements, scenarios and tasks

#### Scenario: The prompt describes the validated schema

- **WHEN** the schema gains a field
- **THEN** the next rendered planning prompt describes that field without any other edit

### Requirement: The plan is validated in code before anything is written

Before any artifact is written the plan SHALL be validated: capability names are kebab-case; task identifiers are well formed and unique; every task requirement reference names a requirement in the plan; every scenario a task cites exists under a requirement it cites; every requirement has at least one scenario; the dependency graph is acyclic; every verification command parses under the shell-safe command parser and uses an executable the verification profile allows; and every scope is repository-relative. Failures SHALL be reported as a list identifying each offending field.

#### Scenario: An unresolvable reference

- **WHEN** a task cites a requirement that the plan does not contain
- **THEN** validation fails naming the task and the reference, and no file is written

#### Scenario: A verification command the host will refuse

- **WHEN** a task's verification command uses an executable the verification profile does not allow
- **THEN** validation fails naming the task, the command and the executable

#### Scenario: A dependency cycle

- **WHEN** two tasks depend on each other
- **THEN** validation fails naming both tasks

### Requirement: Validation failures get one specific retry

When validation or parsing fails, the session SHALL be given the list of failures and one further attempt. The retry message SHALL state the specific failures and SHALL NOT contain generic formatting instructions. A second failure SHALL end the command with an error that carries the list.

#### Scenario: The retry names the failures

- **WHEN** the first plan fails validation with two errors
- **THEN** the second attempt's prompt lists those two errors

#### Scenario: A second failure ends the command

- **WHEN** the retried plan also fails validation
- **THEN** the command fails with an error carrying the failure list and no artifact is written

### Requirement: Code renders every artifact

The proposal, the delta specifications, the design and the task list SHALL be rendered by code from the validated plan using template files, and written to fixed paths under the change's directory. The planning session SHALL NOT write, name or choose artifact paths. Task blocks SHALL render in the existing task metadata format so that downstream parsing is unchanged.

#### Scenario: Artifacts are written from the plan

- **WHEN** a valid plan is accepted
- **THEN** the proposal, one specification per capability, the design and the task list are written by code and the task list parses with the existing task parser

#### Scenario: The session cannot choose a path

- **WHEN** a plan is accepted
- **THEN** every written path is derived from validated capability names and fixed artifact names

### Requirement: Every lane writes all four artifacts

Every lane SHALL produce the proposal, specifications, design and tasks artifacts. When a plan carries no design, the rendered design SHALL state that no decisions beyond the proposal are needed, so the design artifact exists.

#### Scenario: A small plan without a design

- **WHEN** a small-lane plan has no design section
- **THEN** a design artifact is still written and OpenSpec reports all four artifacts done

### Requirement: Disposition is part of the planning session

When triage did not decide the disposition, the planning session SHALL return it, and a clarification or already-satisfied answer SHALL produce the same blocked outcome the separate preflight session produced. No separate preflight agent session SHALL exist.

#### Scenario: The session asks for clarification

- **WHEN** the planning session returns a needs-clarification disposition with a question
- **THEN** the command is blocked with that question as the next step and no artifact is written

#### Scenario: No preflight session runs

- **WHEN** propose runs on any lane
- **THEN** the number of agent sessions before the plan session is zero

### Requirement: Refinement returns a whole plan

Refinement SHALL give the session the current artifacts and any required changes from a review that requested revision, and SHALL accept a whole new plan, rendered over the existing artifacts.

#### Scenario: Required changes are folded in

- **WHEN** refine runs after a review that required changes
- **THEN** the session's prompt contains those required changes and the current artifacts

### Requirement: Lane guidance shapes the plan

The planning prompt SHALL carry lane-specific guidance as a variable: the small lane asks for one requirement, one scenario and one task unless independent files force more; the large lane receives the specialist opinions and debate as prior analysis.

#### Scenario: Small guidance is present

- **WHEN** planning runs on the small lane
- **THEN** the prompt contains the small-lane guidance and the lane's task limit

### Requirement: Planning is decomposed into a library

The planning phase entry point SHALL contain only phase entry and outcome mapping. Plan schema, validation, rendering, session running, budget parsing and orchestration SHALL be separate modules, none larger than about 250 lines.

#### Scenario: The phase file is thin

- **WHEN** the planning phase file is inspected
- **THEN** it contains no schema, validation, rendering or prompt code
