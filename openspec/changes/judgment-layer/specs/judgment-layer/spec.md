## Purpose

Defines how the harness obtains cheap, typed, calibrated answers about a state: the guarantee that it degrades to existing behavior, how shadow and enforce modes differ, how uncertainty is handled, what is recorded about every decision, how spend is accounted, and how tests stay hermetic.

## ADDED Requirements

### Requirement: Operational failures degrade to existing behavior

Every judgment request SHALL resolve to either typed answers or a typed unavailable result that names a reason. An operational failure — judgment disabled, not configured, skipped for budget, a timeout, a rate limit that survives retries, a transport or server failure, an unusable response, or cancellation — SHALL NOT raise an error to the caller and SHALL NOT delay the caller beyond the request's deadline. A caller that receives an unavailable result SHALL behave exactly as it does without judgment.

#### Scenario: Service unreachable

- **WHEN** a request is made and the judgment service cannot be reached
- **THEN** the caller receives an unavailable result with a network reason and no error is raised

#### Scenario: Deadline elapses

- **WHEN** no response arrives within the request's deadline
- **THEN** the caller receives an unavailable result with a timeout reason no later than the deadline

#### Scenario: Rate limit persists

- **WHEN** the service keeps signalling rate limiting after the bounded retries are spent
- **THEN** the caller receives an unavailable result with a rate-limit reason

#### Scenario: Response is unusable

- **WHEN** a response is malformed, omits a requested question, or answers a question with a value that is not one of the supplied options
- **THEN** the caller receives an unavailable result with an invalid-response reason and no partial answers are returned

#### Scenario: Caller cancels

- **WHEN** the caller's cancellation signal fires while a request is in flight
- **THEN** the request ends promptly with an unavailable result with an aborted reason

### Requirement: Malformed question definitions are programming errors

A question definition that is invalid — a duplicate question identifier, an unsupported question type, a choice without options, a rubric without ordered criteria, or an empty question — SHALL be rejected as a programming error that identifies the definition. This SHALL be distinct from operational unavailability, and every catalogued decision SHALL be validated by the automated test suite so that a malformed definition is caught before it can ship.

#### Scenario: Duplicate question identifiers

- **WHEN** a decision builds two questions with the same identifier
- **THEN** the definition is rejected with an error that names the decision and the identifier

#### Scenario: Every catalogued decision is validated

- **WHEN** the automated test suite runs
- **THEN** each catalogued decision is built from representative input and validated, and a malformed definition fails the suite

### Requirement: Disabled judgment is inert

When judgment is disabled or not configured, a decision request SHALL report the corresponding unavailable reason without any network activity, SHALL NOT write any record, and SHALL NOT affect any usage or budget accounting.

#### Scenario: Judgment disabled performs no work

- **WHEN** judgment is disabled or not configured and a decision is requested
- **THEN** the caller receives an unavailable result naming the disabled or unconfigured reason, no request is sent, no record is written, and no usage or budget figure changes

### Requirement: Mode determines whether a decision acts

Once judgment is enabled it SHALL run in shadow mode unless enforce mode is explicitly selected. In shadow mode a decision SHALL be evaluated and recorded, and the caller SHALL be given nothing to act on and SHALL behave exactly as it does without judgment. In enforce mode a decision that acts SHALL hand its outcome to the caller. An unrecognized mode value SHALL be treated as judgment being unavailable, not as either mode.

#### Scenario: Default mode is shadow

- **WHEN** judgment is enabled and no mode is selected
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

### Requirement: Uncertainty falls through to existing behavior

Each decision SHALL define, in one reviewable place, the confidence bands at which it acts. A decision whose answers do not clear those bands SHALL abstain, and abstaining SHALL mean the caller does what it does without judgment. Each decision's question wording and confidence bands SHALL carry a version.

#### Scenario: Answers fall in the uncertain band

- **WHEN** the answers to a decision fall between its acting bands
- **THEN** the decision abstains and the caller behaves as it does without judgment

#### Scenario: Changing a decision changes its version

- **WHEN** a decision's question wording or confidence bands change
- **THEN** the decision's version changes, and recordings made under the earlier version are not reused

### Requirement: Answers never grant permission

No decision SHALL treat a judgment answer as authority to grant a permission, remove a manual checkpoint, or relax a check that exists without judgment. Every decision SHALL declare which effects acting can have — adding caution, adding advice, or reducing work — and a decision that can reduce work SHALL fall through to the full, unreduced activity whenever it abstains.

#### Scenario: Every decision declares its effects

- **WHEN** the decision definitions are inspected
- **THEN** each declares one or more of adding caution, adding advice, and reducing work, and none declares an effect that grants a permission or removes a check

### Requirement: The model is pinned and every decision is recorded

Every request SHALL name one pinned model version and SHALL NOT use a moving alias. A response that reports a different model SHALL be treated as unavailable. Every decision SHALL be recorded in the change's run store with the decision name and version, the mode, the requested and reported model, each question identifier with its answer, probabilities and confidence, the gate outcome, whether the caller acted, and the spend. A request that ends unavailable for any reason other than disabled or not configured SHALL also be recorded, with its reason.

#### Scenario: Pinned model is requested

- **WHEN** any request is sent
- **THEN** it names the pinned model version and never a moving alias

#### Scenario: Reported model differs

- **WHEN** the response reports a model other than the pinned one
- **THEN** the request is unavailable with a model-mismatch reason and the mismatch is recorded

#### Scenario: Decision record contents

- **WHEN** a decision completes with answers
- **THEN** a record exists in the change's run store containing the decision name and version, the mode, the requested and reported model, every question identifier with its answer, probabilities and confidence, the gate outcome, whether the caller acted, and the spend

#### Scenario: Unavailable result is recorded

- **WHEN** judgment is enabled and a request ends unavailable for a reason other than disabled or not configured
- **THEN** a record naming that reason exists in the change's run store

### Requirement: Records can be reconciled with what actually happened

A decision record SHALL be able to receive the outcome that the existing behavior or the expensive stage actually reached, together with whether that outcome agreed with the judgment. Reconciling a record more than once SHALL merge the observations without discarding earlier ones. Reconciling a record that does not exist SHALL be reported without raising an error.

#### Scenario: Reconciled after the fact

- **WHEN** the expensive stage finishes after a shadow decision
- **THEN** the decision's record holds the stage's outcome and whether it agreed with the judgment

#### Scenario: Repeated reconciliation merges

- **WHEN** a record is reconciled a second time with an additional observation
- **THEN** the record holds both observations

#### Scenario: Reconciling a missing record is harmless

- **WHEN** reconciliation is requested for a record that does not exist
- **THEN** it reports that the record was not found and raises no error

### Requirement: Decisions are summarized for calibration

The layer SHALL summarize a change's records per decision: the number of calls, unavailable results by reason, shadow and enforced counts, how often the decision would have acted and how often it did, agreement among reconciled records, the spend, and the estimated cost of the activity avoided when the decision acted.

#### Scenario: Summary reports per decision

- **WHEN** records for several decisions are summarized
- **THEN** each decision has its own calls, unavailable reasons, mode counts, agreement, spend, and avoided-cost figures

#### Scenario: Would have acted is distinct from acted

- **WHEN** a decision ran in shadow mode and would have acted
- **THEN** the summary counts it as would-have-acted and not as acted

#### Scenario: Unreconciled records are excluded from agreement

- **WHEN** some records have not been reconciled
- **THEN** agreement is computed over reconciled records only, and the number reconciled is reported alongside it

### Requirement: Judgment spend is visible in existing accounting

Each judgment call that receives a response SHALL emit a usage record attributed to the caller's phase under a distinct judgment role, reporting input tokens from the response, output tokens as zero, and a cost derived from the pinned per-token rate. Judgment SHALL be an optional activity: a request forecast to exceed a configured budget SHALL be skipped as unavailable and SHALL NOT block any mandatory activity.

#### Scenario: Usage is recorded for every judgment call

- **WHEN** a request completes with answers, whether the decision acts, abstains, or runs in shadow mode
- **THEN** a usage record exists under the judgment role in the caller's phase with the response's input tokens, zero output tokens, and the cost from the pinned rate

#### Scenario: Budget exhaustion skips judgment

- **WHEN** the forecast for a request exceeds a configured budget scope
- **THEN** the request is skipped as unavailable with a budget reason, no request is sent, and no mandatory activity is blocked as a result

### Requirement: Tests never reach the network

Automated tests SHALL run judgment against recorded responses keyed by the decision, its version, and the content of the state and the questions. A request for which no recording exists SHALL fail the test rather than reach the service, and SHALL NOT be treated as an unavailable result. Recordings SHALL be producible from a live run without changing the code under test.

#### Scenario: Recorded response is replayed

- **WHEN** a test requests a decision for which a recording exists
- **THEN** the recorded response is used and no network request is made

#### Scenario: Missing recording fails the test

- **WHEN** a test requests a decision for which no recording exists
- **THEN** the test fails with an error naming the decision, and the request is not treated as unavailable

#### Scenario: Different content is a different recording

- **WHEN** the state or the questions differ from those of a recording
- **THEN** the recording does not match and the request is treated as having no recording

### Requirement: The layer is a library that calls nothing back

The judgment layer SHALL NOT depend on phases, command handlers, controllers, agents, tools, or execution modules; those modules depend on it. An automated test SHALL enforce the restriction.

#### Scenario: Layer dependencies are restricted

- **WHEN** the layer's modules are scanned for their dependencies
- **THEN** none depends on a phase, handler, controller, agent, tool, or execution module
