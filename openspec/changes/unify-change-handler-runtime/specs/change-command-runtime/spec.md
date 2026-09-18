## Purpose

Defines the uniform runtime contract every `/change` subcommand shares: declared command metadata, one normalized handler request and outcome, a single transcript presentation identity, consistent model-resolution precedence, and a configuration seam separated from test overrides.

## ADDED Requirements

### Requirement: Single transcript presentation identity

The `/change` command surface SHALL have exactly one exported custom message type that identifies every transcript message and interface widget it emits. Widget keys SHALL be derived from that exported value rather than re-declared as literal text. Every transcript message the surface emits SHALL carry a structured details payload describing the action, change name, outcome status, run identity, and error code when present, and SHALL also carry human-readable content that remains meaningful when no renderer is registered.

#### Scenario: Interactive host renders a phase result

- **WHEN** a phase completes and the surface posts its result to a host that supports message renderers
- **THEN** the message is tagged with the surface's custom message type and its details payload reports the action, change name, status, and run identity of that invocation

#### Scenario: Host has no renderer registered

- **WHEN** the same result is posted to a host that renders no custom types
- **THEN** the message still displays its human-readable content, including status and next-step guidance

#### Scenario: Progress widget is displayed

- **WHEN** the surface displays a live agent-progress widget
- **THEN** the widget key is derived from the surface's exported custom message type, so the identity cannot drift from the message type

### Requirement: Declared per-action command metadata

Each `/change` action SHALL declare its argument shape, whether it requires a change name, whether it is lifecycle-gated, and whether it uses stable per-change run identity. Argument parsing, usage text, the advertised subcommand list, lifecycle gating, active-change persistence, and run-identity selection SHALL be derived from those declarations.

#### Scenario: Action taking free-text arguments is parsed

- **WHEN** a user invokes an action declared to take free-text arguments
- **THEN** the entire argument remainder is treated as free text and no word from it is interpreted or persisted as a change name

#### Scenario: New action is added

- **WHEN** an action is added to the declarations with its argument shape, change requirement, lifecycle gating, and run-identity kind
- **THEN** parsing, usage text, the advertised subcommand list, gating, and run-identity selection follow the declaration without additional per-action branching

#### Scenario: Declared arity is violated

- **WHEN** a user supplies an argument count that the action's declared shape does not accept
- **THEN** the invocation reports a blocked outcome stating the accepted usage for that action and performs no phase work

### Requirement: Uniform subcommand handler contract

Every `/change` subcommand handler SHALL receive one normalized request that supplies the resolved change name when the action declares one is required, the joined free-text argument, the raw arguments, the working directory, one cancellation signal, the run identity, the agent-run observer, the confirming actor, and on-demand access to the change snapshot. A handler SHALL return the outcome status, summary, next step, and blocker for its result; the action and change name SHALL be attached by the shared contract rather than restated by each handler.

#### Scenario: Handler for an action requiring a change name

- **WHEN** a handler for an action declared to require a change name executes
- **THEN** the change name is present in its request as a non-optional value and the handler performs no runtime assertion or fallback to obtain it

#### Scenario: Required change name is absent

- **WHEN** an action declared to require a change name is invoked without one and none can be resolved
- **THEN** the shared contract reports a blocked outcome naming the accepted usage and the handler is not invoked

#### Scenario: Invocation is cancelled

- **WHEN** the host cancels an invocation of any subcommand
- **THEN** the cancellation reaches the phase work for that subcommand regardless of which subcommand it is

### Requirement: Consistent progress and actor reporting across phases

Every phase that starts agent runs SHALL report those runs to the invocation's agent-run observer. Every phase that records a human confirmation SHALL record the actor supplied by the host invocation, and the host invocation SHALL supply that actor.

#### Scenario: Verification or finish phase starts an agent run

- **WHEN** a phase that was previously unable to report progress starts an agent run
- **THEN** the run appears in live progress output and in the end-of-invocation usage summary, exactly as runs from other phases do

#### Scenario: Manual checkpoint is confirmed

- **WHEN** a user confirms a pending manual checkpoint
- **THEN** the persisted confirmation records the actor identity supplied by the host rather than a fixed placeholder

### Requirement: Uniform model resolution precedence

Model selection for every role and every phase SHALL apply one precedence order: environment override, then configured model-stack slot, then command-line flag, then a declared fallback. An environment override SHALL be available for each role, not only for exploration. No phase SHALL define its own independent fallback value.

#### Scenario: Environment override is set for a non-exploration role

- **WHEN** an environment override is set for a role used by a planning, review, implementation, or verification phase
- **THEN** that phase uses the overridden model

#### Scenario: Model stack is configured

- **WHEN** a model-stack configuration file is supplied and no environment override is set
- **THEN** every role resolves to its slot from that configuration, so phases follow the models the user already configured and authenticated

#### Scenario: Nothing is configured

- **WHEN** no environment override, configuration file, or command-line flag is present
- **THEN** every role resolves to the single declared fallback for that role and no phase supplies a competing fallback

### Requirement: Separated configuration and test overrides

Invocation configuration SHALL be represented separately from test-only substitution points. Each substitution point SHALL accept only the values it needs rather than the whole configuration and sibling substitution points. Each phase SHALL declare its own options type rather than reusing another phase's type.

#### Scenario: Substitution point is invoked

- **WHEN** a test substitutes a state-loading or phase-running boundary
- **THEN** the substituted boundary receives only its declared inputs and cannot observe or depend on other substitution points

#### Scenario: Phase options are declared

- **WHEN** a phase declares the options it accepts
- **THEN** those options belong to that phase and are not borrowed from an unrelated phase

### Requirement: No unused per-invocation state construction

The runtime SHALL NOT resolve change locations, model stacks, or output sinks for an invocation unless a handler for that invocation consumes them. Read-only actions SHALL NOT trigger change-location or model resolution that they do not use.

#### Scenario: Status is invoked

- **WHEN** a user invokes a read-only status action
- **THEN** no model-stack resolution is performed for that invocation

#### Scenario: Per-invocation value is retained

- **WHEN** the runtime constructs per-invocation state
- **THEN** every field it constructs is read by at least one handler or by the shared handler contract

### Requirement: Single ownership of shared runtime helpers

Behavior shared across runtime modules — command-line flag reading, filesystem path existence probing, path-containment checking, persisted record reading, validated task-document loading, source-digest reading, and change run-store opening — SHALL each have exactly one implementation used by all callers.

#### Scenario: Shared behavior is needed by a second module

- **WHEN** a runtime module needs one of these behaviors
- **THEN** it uses the single shared implementation and does not define a local copy

#### Scenario: Shared behavior changes

- **WHEN** one of these behaviors is corrected
- **THEN** the correction applies to every caller without further edits
