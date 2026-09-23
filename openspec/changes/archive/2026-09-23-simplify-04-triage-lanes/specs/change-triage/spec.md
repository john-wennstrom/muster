## ADDED Requirements

### Requirement: One request answers disposition, risk and reach

Propose and refine SHALL make at most one triage judgment request per invocation, covering the request's disposition, the four risk questions (public contract, data migration, security boundary, design ambiguity), whether the change is mechanical, how far it reaches, and for each candidate file whether it implements the request and whether it needs to change for it. The state sent SHALL be the request text, the phase and the candidates' paths and excerpts, and SHALL NOT be larger than what the separate preflight and complexity requests sent together.

#### Scenario: One request per invocation

- **WHEN** propose runs with judgment enabled and no explicit lane
- **THEN** exactly one triage request is sent

#### Scenario: Refinement includes the previous review's required changes

- **WHEN** refine runs after a review that required changes
- **THEN** the request text in the triage state includes those required changes

### Requirement: Candidates are retrieved by code

The candidate files given to triage SHALL be retrieved by code from the repository using identifiers in the request, at most ten files, each with its path and an excerpt of at most 600 bytes, excluding files named by the credential denylist, ignored files, binary files, files over 2 MiB and dependency directories. Retrieval SHALL run whether or not judgment is enabled.

#### Scenario: Candidates are bounded and filtered

- **WHEN** retrieval finds more than ten matching files, some of them denylisted
- **THEN** at most ten are returned, none denylisted, each with an excerpt of at most 600 bytes

#### Scenario: Retrieval runs without judgment

- **WHEN** judgment is disabled
- **THEN** candidates are still retrieved and used for the pattern classification, and nothing is sent

### Requirement: Small requires confident evidence for everything

A change SHALL be assigned the small lane by judgment only when the classification computed from the candidates and the merged risk answers is direct, all four risk answers were judged with confidence and are no, and reach was judged with confidence to be within one function, one file or one module. Any other case SHALL NOT be assigned small by judgment.

#### Scenario: Every condition holds

- **WHEN** triage confidently answers no to all four risks and confidently places reach within one module, and the computed classification is direct
- **THEN** the lane is small with source judgment

#### Scenario: One risk is uncertain

- **WHEN** triage answers no to three risks confidently and is uncertain about the fourth
- **THEN** the lane is not small

#### Scenario: Patterns alone never give small

- **WHEN** judgment is unavailable and the pattern classification is direct
- **THEN** the lane is medium

### Requirement: A confident risk answer raises the lane

A confident yes to a risk question SHALL replace the pattern value for that one input, and the lane SHALL follow the resulting classification, direct and bounded giving medium and architectural giving large. Design ambiguity SHALL apply only in refinement.

#### Scenario: A confident migration answer raises the lane

- **WHEN** triage confidently answers yes to data migration
- **THEN** the classification is architectural and the lane is large

#### Scenario: Ambiguity is ignored in a proposal

- **WHEN** triage answers yes to design ambiguity during propose
- **THEN** the answer does not change the lane

### Requirement: Pattern classification is the floor

The pattern classification over candidate files and request text SHALL be computed on every invocation and SHALL never be lowered by judgment except through the small-lane rule. Uncertain answers SHALL leave each input at its pattern value.

#### Scenario: An uncertain answer keeps the pattern value

- **WHEN** triage is uncertain about the security boundary question and the request text matches the security pattern
- **THEN** the security input stays true

### Requirement: Negation and scope are read as written

The wording of the risk questions SHALL make explicit that a request that explicitly avoids a migration answers no to data migration, that internal signature changes are not public contract changes, and that work near authorization code that does not change what is allowed or trusted answers no to the security boundary.

#### Scenario: A request that avoids a migration

- **WHEN** the request says to keep existing data as it is
- **THEN** the data migration question is answered no

### Requirement: A confident proceed skips the agent

In enforce mode, a proceed disposition with confidence at or above the floor SHALL produce the preflight result without running the preflight agent, composed by code from the answers and the candidates, so that nothing downstream can tell which path produced it.

#### Scenario: Confident proceed

- **WHEN** triage confidently answers proceed in enforce mode
- **THEN** no preflight agent session starts and planning continues with evidence composed from the relevant candidates

### Requirement: A confident, corroborated already-satisfied blocks without the agent

In enforce mode, an already-satisfied disposition SHALL block the command without running the agent only when its confidence is at or above the floor and at least one candidate is confidently judged to implement the request. The blocked outcome SHALL carry the standard question naming the branch, deployment or entry point that still fails.

#### Scenario: Corroborated already-satisfied

- **WHEN** triage confidently answers already-satisfied and a candidate is judged to implement the request
- **THEN** the command is blocked with the standard question and no agent runs

#### Scenario: Uncorroborated already-satisfied

- **WHEN** triage answers already-satisfied but no candidate is judged to implement the request
- **THEN** the agent runs with the candidates

### Requirement: Clarification always runs the agent

A needs-clarification disposition SHALL never act, at any confidence, because its product is a question that judgment cannot write. The agent SHALL run and write it.

#### Scenario: Clarification at high confidence

- **WHEN** triage answers needs-clarification with high confidence
- **THEN** the preflight agent runs

### Requirement: Below the confidence floor the agent runs with the candidates

When the disposition is not confident, the agent SHALL run, with the retrieved candidates listed in its prompt as starting points, in enforce mode only.

#### Scenario: Uncertain disposition in enforce mode

- **WHEN** triage's disposition is below the floor in enforce mode
- **THEN** the agent runs and its prompt lists the candidates

### Requirement: Shadow mode uses the pattern lane and records the alternative

In shadow mode the lane SHALL be the pattern lane, the agent SHALL run exactly as it does without judgment, and the record SHALL hold the lane that enforce mode would have chosen and later whether the change escalated.

#### Scenario: Shadow triage

- **WHEN** triage runs in shadow mode and would have chosen small
- **THEN** the lane used is the pattern lane and the record holds small as the lane it would have chosen

### Requirement: Unavailable triage yields the pattern lane

When judgment is disabled, unavailable or unusable, the lane SHALL be the pattern lane and the preflight agent SHALL run, and no error SHALL be raised.

#### Scenario: Service unreachable

- **WHEN** the triage request cannot be answered
- **THEN** the lane is the pattern lane, the agent runs and the command proceeds

### Requirement: Triage egress is documented

The security documentation SHALL contain one call-site row for triage naming the state it sends, and SHALL NOT contain rows for the removed preflight and complexity decisions.

#### Scenario: One row replaces two

- **WHEN** the security documentation's call-site table is read
- **THEN** it has a triage row and no preflight or complexity row
