## ADDED Requirements

### Requirement: The temporary allowlists are empty

The source-hygiene guard's temporary allowlist and the prompt-template exclusion list SHALL NOT exist, and every module under the source tree SHALL have a production importer or be a declared entry point, and every catalogued decision SHALL have a question file.

#### Scenario: No module is allowlisted

- **WHEN** the source-hygiene guard runs
- **THEN** it passes with no allowlist file present

#### Scenario: Every decision has a question file

- **WHEN** the prompt-template test runs
- **THEN** every catalogued decision has a question file and no exclusion list is read

### Requirement: No source module exceeds a size budget

No module under the source tree SHALL exceed 500 lines. An automated test SHALL fail and name any module that does.

#### Scenario: A module over the budget fails

- **WHEN** a source module has more than 500 lines
- **THEN** the size-budget test fails naming the module

### Requirement: Test files stay reviewable

No test file SHALL exceed 600 lines unless its first comment contains a line beginning with `size-budget:` that states the reason. An automated test SHALL fail and name any file that does.

#### Scenario: An unjustified large test file fails

- **WHEN** a test file has more than 600 lines and no size-budget comment
- **THEN** the size-budget test fails naming the file

#### Scenario: A justified exception passes

- **WHEN** a test file has more than 600 lines and a size-budget comment giving a reason
- **THEN** the size-budget test passes for that file

### Requirement: A small change has an agent-session budget

With agents stubbed, a small-lane change of one task SHALL start at most three agent sessions from proposal to a passing verification, and a medium-lane change of one task at most four. The test SHALL record the kind of each session started, and a change to these figures SHALL be made in the change that needs it, with a stated reason.

#### Scenario: A small change stays within three sessions

- **WHEN** a one-task change is planned, reviewed, implemented and verified on the small lane
- **THEN** at most three agent sessions start, and none is a planning reviewer

#### Scenario: A medium change stays within four sessions

- **WHEN** a one-task change is planned, reviewed, implemented and verified on the medium lane with judgment unavailable
- **THEN** at most four agent sessions start

#### Scenario: A large change runs opinions and a debate

- **WHEN** a change is planned on the large lane with the optional budget available
- **THEN** specialist opinions and a debate start before the plan session
