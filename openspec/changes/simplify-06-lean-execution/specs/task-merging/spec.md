## ADDED Requirements

### Requirement: Chained tasks with the same write scope are merged

After a plan validates and before it is rendered, a task SHALL be merged into its predecessor when it depends on exactly that predecessor, the predecessor has no other dependent, both are builder tasks, neither is manual, and their write scopes are identical as sets of normalized paths. Merging SHALL repeat until no task qualifies. Tasks that do not meet every condition SHALL NOT be merged.

#### Scenario: A same-scope chain merges

- **WHEN** task 1.2 depends only on 1.1, nothing else depends on 1.1, and both write the same files
- **THEN** the plan contains one task, 1.1, covering both

#### Scenario: Different scopes do not merge

- **WHEN** task 1.2 depends only on 1.1 but writes a file that 1.1 does not
- **THEN** both tasks remain

#### Scenario: A manual task is never merged

- **WHEN** a task that would otherwise merge is a manual task
- **THEN** it remains a separate task

#### Scenario: A fan-out is not merged

- **WHEN** two tasks depend on 1.1
- **THEN** neither is merged into it

### Requirement: Merging preserves coverage

A merged task SHALL keep the predecessor's identifier, join both descriptions in order, and carry the deduplicated union of reads, requirement references, scenario references and verification commands, and every task that depended on the merged-away task SHALL depend on the surviving task. No requirement, scenario or verification command SHALL be lost.

#### Scenario: References and commands are unioned

- **WHEN** two tasks merge and cite different scenarios and commands
- **THEN** the merged task cites all scenarios and runs all commands, without duplicates

#### Scenario: Dependents are rewired

- **WHEN** a task depended on the merged-away task
- **THEN** it depends on the surviving task

### Requirement: Merges are reported

The planning outcome SHALL list each merge with the task identifiers and the reason, so the plan the user sees explains itself.

#### Scenario: The outcome lists a merge

- **WHEN** planning merges task 1.2 into 1.1
- **THEN** the outcome states that 1.2 was merged into 1.1 because they share a write scope

### Requirement: The planner is told to prefer cohesive tasks

The planning prompt SHALL instruct the session to prefer one task per cohesive set of files and to split only when parallelism or independent verification is real.

#### Scenario: The instruction is present

- **WHEN** the planning prompt is rendered
- **THEN** it contains the cohesive-task instruction
