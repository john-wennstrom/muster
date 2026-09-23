## ADDED Requirements

### Requirement: Every agent prompt and every judgment question is a template file

The text of every prompt sent to a model agent, and the wording of every question sent to the judgment service, SHALL be stored in template files under a prompts directory, separate from the code that supplies their variables. Agent prompts SHALL be Markdown files and judgment questions SHALL be YAML files named for their decision. No source module SHALL contain prompt or question wording other than variable values that a template receives. A decision that a planned later change deletes or replaces MAY be excluded through a temporary list that names that change, and an entry SHALL NOT be added to it for any other reason.

#### Scenario: An agent prompt is read from a file

- **WHEN** planning, exploration, planning review, a builder or a task review starts an agent
- **THEN** the prompt text comes from a Markdown template file and the code supplies only variable values

#### Scenario: A decision's questions are read from a file

- **WHEN** a judgment decision builds its questions
- **THEN** the wording comes from the YAML file named for that decision

#### Scenario: A doomed decision is excluded by name

- **WHEN** a decision is scheduled for deletion or replacement by a later change
- **THEN** it may remain in code only while it appears in the temporary exclusion list naming that change

### Requirement: Rendering is strict about variables

A template SHALL declare its variables. Rendering SHALL fail with an error that names the template and the variable when a declared variable is not supplied, when a supplied variable is not declared, when the body uses a placeholder that is not declared, or when a declared variable is never used in the body. Optional blocks SHALL be expressed as variables that may be empty, and an empty block SHALL leave no extra blank line in the result.

#### Scenario: Missing variable

- **WHEN** a template is rendered without one of its declared variables
- **THEN** rendering fails naming the template and the variable, and no text is produced

#### Scenario: Unknown variable

- **WHEN** a template is rendered with a variable it does not declare
- **THEN** rendering fails naming the template and the variable

#### Scenario: Undeclared placeholder

- **WHEN** a template body uses a placeholder that its front matter does not declare
- **THEN** loading the template fails naming the placeholder

#### Scenario: Empty optional block

- **WHEN** a template is rendered with an empty value for an optional block
- **THEN** the result contains no run of blank lines where the block would have been

### Requirement: Agents accept only rendered prompts

The entry point that starts a model agent SHALL accept only a prompt produced by the template renderer, enforced by its type and checked when it runs. A raw string SHALL NOT reach an agent.

#### Scenario: A raw string is rejected

- **WHEN** the agent entry point is called with a prompt that did not come from the renderer
- **THEN** the call fails without starting a child process

### Requirement: Judgment questions load through the existing validation

Loading a decision's questions SHALL expand per-item entries once per item of the named list, substitute variables, and pass the result through the same question validation used for every decision, so that a duplicate identifier, an unsupported type, a choice without options or a rubric without criteria is still rejected as a programming error naming the decision.

#### Scenario: Per-item questions expand

- **WHEN** a decision's file declares a per-item entry and the caller supplies three items
- **THEN** three questions result, identified by their one-based index

#### Scenario: Malformed file is a programming error

- **WHEN** a decision's file contains two questions with the same identifier
- **THEN** loading fails with an error naming the decision and the identifier

#### Scenario: Gate identifiers exist in the file

- **WHEN** the test suite runs
- **THEN** every question identifier a decision's gate reads is present in that decision's file

### Requirement: Moving wording preserves it exactly

For the same inputs, every agent prompt and every decision's questions SHALL render identically to how they rendered before their wording moved into files. Golden outputs captured before the move SHALL remain in the test suite, and a change to any wording SHALL regenerate the affected golden in the same change.

#### Scenario: Agent prompts match their goldens

- **WHEN** each agent prompt is rendered from its sample inputs
- **THEN** the result equals the stored golden byte for byte

#### Scenario: Questions match their fingerprints

- **WHEN** each decision's questions are built from its representative input
- **THEN** their canonical form equals the stored golden and their fingerprint is unchanged

### Requirement: Templates are found regardless of the working directory

The prompts directory SHALL be resolved relative to the installed package and SHALL be included in the published package files. A missing template SHALL be an error at load time that names the file.

#### Scenario: Rendering from another repository

- **WHEN** the working directory is a repository other than the one containing the package
- **THEN** templates still resolve and render

#### Scenario: Missing template file

- **WHEN** a template file that is referenced does not exist
- **THEN** loading fails naming the file
