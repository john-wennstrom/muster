## REMOVED Requirements

### Requirement: Mode determines whether a decision acts
**Reason**: The default mode changes from shadow to enforce, so the requirement is replaced by one that states the new default.
**Migration**: See "Enforce is the default mode once judgment is enabled".

### Requirement: Tests never reach the network
**Reason**: Recorded responses are replaced by a scripted client, so the requirement is replaced by one that describes it.
**Migration**: See "Tests run against a scripted client".

## ADDED Requirements

### Requirement: Enforce is the default mode once judgment is enabled

Once judgment is enabled it SHALL run in enforce mode unless shadow mode is explicitly selected. In shadow mode a decision SHALL be evaluated and recorded, and the caller SHALL be given nothing to act on and SHALL behave exactly as it does without judgment. In enforce mode a decision that acts SHALL hand its outcome to the caller. An unrecognized mode value SHALL be treated as judgment being unavailable, not as either mode.

#### Scenario: Default mode is enforce

- **WHEN** judgment is enabled by its flag and an API key and no mode is selected
- **THEN** decisions run in enforce mode

#### Scenario: Shadow mode is explicit

- **WHEN** judgment is enabled and the mode is set to shadow
- **THEN** decisions run in shadow mode

#### Scenario: Shadow mode does not hand over an outcome

- **WHEN** a decision in shadow mode produces answers that clear its confidence bands
- **THEN** the record shows the decision would have acted, the caller receives no outcome to act on, and the caller's behavior is identical to running without judgment

#### Scenario: Enforce mode hands over an acting outcome

- **WHEN** a decision in enforce mode produces answers that clear its confidence bands
- **THEN** the caller receives the acting outcome and the record shows the caller acted

#### Scenario: Unrecognized mode is unavailable

- **WHEN** the mode value is not a recognized mode
- **THEN** every decision reports unavailable with an invalid-configuration reason and no request is sent

### Requirement: Tests run against a scripted client

Automated tests SHALL run judgment against a scripted client that returns answers declared by the test, keyed by decision and question identifier, or against a client that reports a chosen unavailable reason. A request that the script does not cover SHALL fail the test with an error naming the decision rather than reach the service, and SHALL NOT be treated as an unavailable result. The transport's parsing of a response body SHALL be tested against a canned payload in the service's response shape.

#### Scenario: Scripted answers are used

- **WHEN** a test scripts answers for a decision and the code under test requests that decision
- **THEN** the scripted answers are returned and no network request is made

#### Scenario: An uncovered request fails the test

- **WHEN** a test requests a decision that its script does not cover
- **THEN** the test fails with an error naming the decision, and the request is not treated as unavailable

#### Scenario: Each unavailable reason can be simulated

- **WHEN** a test uses a client that reports a chosen unavailable reason
- **THEN** the caller receives an unavailable result with that reason and no error is raised

#### Scenario: The transport parses the service's response shape

- **WHEN** the transport is given a canned response body in the service's documented shape
- **THEN** it returns typed answers, and a body that omits a requested question is reported as unusable
