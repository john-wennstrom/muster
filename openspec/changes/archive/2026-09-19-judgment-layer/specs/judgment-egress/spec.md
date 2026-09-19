## Purpose

Defines what may leave the machine when judgment is used: the explicit opt-in, the redaction and credential denylist applied to every outgoing state, the size limits, and the obligation to document each call site's egress before it ships.

## ADDED Requirements

### Requirement: Judgment is opt-in

No repository content SHALL be sent to the judgment service unless both an enabling flag and an API key are present. With either absent the harness SHALL behave exactly as it does without judgment, and the two conditions SHALL be distinguishable in the unavailable reason (disabled versus not configured).

#### Scenario: Neither variable is set

- **WHEN** neither the enabling flag nor the API key is set
- **THEN** no request is sent and decisions report unavailable as disabled

#### Scenario: Flag without a key

- **WHEN** the enabling flag is set and no API key is present
- **THEN** no request is sent and decisions report unavailable as not configured

#### Scenario: Key without the flag

- **WHEN** an API key is present and the enabling flag is not set
- **THEN** no request is sent and decisions report unavailable as disabled

#### Scenario: Both are present

- **WHEN** the enabling flag is set and an API key is present
- **THEN** decisions are eligible to send requests, subject to the remaining egress controls

### Requirement: Secrets are redacted before leaving the machine

Every string in a state SHALL be redacted before transmission of bearer credentials, credential-bearing command flags, `key: value` secret patterns, private key blocks, and secret-bearing URL query parameters. The API key SHALL NOT appear in any state, record, log, or recorded fixture.

#### Scenario: Bearer credential in failure output

- **WHEN** a state contains failure output that includes an authorization header with a bearer credential
- **THEN** the credential is replaced before the state is sent

#### Scenario: Credential flag in a command

- **WHEN** a state contains a command line with a token, password, or API-key flag
- **THEN** the flag's value is replaced before the state is sent

#### Scenario: The API key is never persisted

- **WHEN** decisions complete and their records and recordings are inspected
- **THEN** none contains the API key

### Requirement: Credential files and the environment are never sent

A state SHALL NOT include the process environment, and SHALL NOT include content originating from environment files, private key or certificate files, or package-registry and cloud credential files, regardless of redaction. A request whose state draws on such content SHALL be reported as unavailable with a state-denied reason and SHALL NOT be sent.

#### Scenario: Environment file content is denied

- **WHEN** a request's state draws on content from an environment file
- **THEN** the request is unavailable with a state-denied reason and nothing is sent

#### Scenario: Credential file content is denied

- **WHEN** a request's state draws on content from a private key, certificate, package-registry authentication, or cloud credential file
- **THEN** the request is unavailable with a state-denied reason and nothing is sent

#### Scenario: Ordinary source content is allowed

- **WHEN** a request's state draws on ordinary source, specification, or documentation files
- **THEN** the request is not denied on account of those files

#### Scenario: The process environment is never included

- **WHEN** any request is sent
- **THEN** its state contains no part of the process environment

### Requirement: State size is bounded and never silently truncated

A request whose state plus its longest single question exceeds 32,000 tokens, or whose state plus all of its questions exceeds 64,000 tokens, SHALL be reported as unavailable with a state-too-large reason and SHALL NOT be sent. Token counts SHALL be estimated conservatively. The layer SHALL NOT truncate a state; callers are responsible for excerpting.

#### Scenario: State too large for the longest question

- **WHEN** a state plus the longest question is estimated above 32,000 tokens
- **THEN** the request is unavailable with a state-too-large reason and nothing is sent

#### Scenario: State too large for all questions

- **WHEN** a state plus all questions is estimated above 64,000 tokens
- **THEN** the request is unavailable with a state-too-large reason and nothing is sent

#### Scenario: State within limits

- **WHEN** a state and its questions are within both limits
- **THEN** the state is sent exactly as supplied, after redaction, with no truncation

### Requirement: Egress is documented before it ships

The security documentation SHALL state that judgment is a third-party egress point for repository content, name the opt-in variables, describe redaction as best-effort rather than a guarantee, state the provider's stated data-handling posture and that operators handling proprietary code should confirm their retention arrangement, and contain a table naming the state each enabled call site sends. The security documentation SHALL continue to pass the repository's documentation checks, including its required wording on host-execution isolation.

#### Scenario: Security documentation names the egress

- **WHEN** the security documentation is read
- **THEN** it identifies judgment as third-party egress, names the opt-in variables, describes redaction as best-effort, states the data-handling posture, and contains the per-call-site table

#### Scenario: Documentation checks pass

- **WHEN** the repository's documentation checks run
- **THEN** they pass with the new section present
