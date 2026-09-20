## ADDED Requirements

### Requirement: The security table names every decision

The call-site table in the security documentation SHALL contain a row for every decision in the judgment catalog, and the documentation check SHALL fail and name any catalogued decision without one.

#### Scenario: A decision without a row fails the check

- **WHEN** a decision is catalogued and the security table has no row for it
- **THEN** the documentation check fails naming the decision

#### Scenario: A complete table passes

- **WHEN** every catalogued decision has a row
- **THEN** the documentation check passes this rule

### Requirement: The command flow document names every action and decision

The command flow document SHALL mention every action in the command table and every catalogued decision, and the documentation check SHALL fail and name any that are missing.

#### Scenario: A missing action fails the check

- **WHEN** an action exists in the command table and the flow document does not mention it
- **THEN** the documentation check fails naming the action

#### Scenario: A missing decision fails the check

- **WHEN** a decision is catalogued and the flow document does not mention it
- **THEN** the documentation check fails naming the decision

### Requirement: Documentation describes lanes and the retired surface

The README SHALL describe the three lanes, the lane option and the small-lane path, and SHALL state which commands were retired. No documentation SHALL describe a retired command as available.

#### Scenario: The README describes lanes

- **WHEN** the README is read
- **THEN** it explains small, medium and large lanes, the lane option and that small changes are approved by lint

#### Scenario: No retired command is described as available

- **WHEN** the documentation is searched for the retired command names
- **THEN** each occurrence states that the command was retired
