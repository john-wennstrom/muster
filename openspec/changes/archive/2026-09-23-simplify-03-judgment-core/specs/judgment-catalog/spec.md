## ADDED Requirements

### Requirement: Each decision is one module

Every decision SHALL be defined in its own module under a decisions directory, containing that decision's input type, state builder, gate and presenter, and SHALL NOT share a module with another decision. A catalog SHALL list every decision, and the automated validation of every catalogued decision SHALL cover exactly the decisions the catalog lists.

#### Scenario: A decision module defines one decision

- **WHEN** the decisions directory is scanned
- **THEN** each module defines exactly one decision

#### Scenario: The catalog lists every decision

- **WHEN** the decisions directory and the catalog are compared
- **THEN** every decision module appears in the catalog and every catalogued decision has a module

### Requirement: Call sites use one helper that never throws

Callers SHALL obtain a decision's verdict through a single helper. The helper SHALL return no verdict when judgment is disabled or unavailable, SHALL NOT raise for an operational failure, and SHALL return a verdict whose reconcile operation merges an observation into the decision's record and never raises. No call site SHALL contain its own error handling for judgment, and no call site SHALL special-case a test-only error.

#### Scenario: Disabled judgment yields no verdict

- **WHEN** a caller asks for a verdict and judgment is disabled
- **THEN** the helper returns no verdict and no request is sent

#### Scenario: An unavailable service yields no verdict

- **WHEN** a caller asks for a verdict and the service is unreachable
- **THEN** the helper returns no verdict and raises no error

#### Scenario: Reconciliation never raises

- **WHEN** a verdict's reconcile operation is called and the record store fails
- **THEN** it completes without raising and the caller's behavior is unchanged

### Requirement: Decisions have no separate enabling flags

A decision SHALL run whenever judgment is enabled. No decision SHALL declare its own enabling variable. A decision whose action needs configuration to make sense, such as a model named for an economy lane, SHALL be inert without that configuration rather than requiring a flag.

#### Scenario: A decision runs when judgment is enabled

- **WHEN** judgment is enabled and a decision's call site is reached
- **THEN** the decision is asked without any further variable being set

#### Scenario: No decision declares a flag

- **WHEN** the catalog is inspected
- **THEN** no decision has an enabling variable

### Requirement: One generic summary replaces per-decision reports

The harness SHALL NOT contain a report module specific to one decision. The change status command SHALL show a judgment block built from the generic per-decision summary, listing per decision the calls, the acted and would-have-acted counts, the unavailable reasons and the agreement over reconciled records, and SHALL show nothing when the change has no decision records.

#### Scenario: Status shows the judgment block

- **WHEN** a change has decision records and status is requested
- **THEN** the output includes each decision's calls, acted count, would-have-acted count, unavailable reasons and agreement

#### Scenario: Status is unchanged without records

- **WHEN** a change has no decision records
- **THEN** the status output contains no judgment block

### Requirement: A manual probe checks wording against the live service

A script SHALL send each decision's representative input to the live service and print the answers and the gate outcome, and SHALL NOT be run by the automated test suite or continuous integration.

#### Scenario: The probe prints a decision's outcome

- **WHEN** the probe is run for a decision with a configured key
- **THEN** it prints the answers by question identifier and whether the gate would act

#### Scenario: The suite never runs the probe

- **WHEN** the automated test suite runs
- **THEN** the probe is not executed and no request reaches the service
