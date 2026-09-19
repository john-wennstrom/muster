# judgment-preflight Specification

## Purpose

Defines how planning preflight decides whether a request should proceed, is already satisfied, or needs clarification: candidate retrieval by code, a single typed judgment over the candidates, direct action only where judgment can produce the whole outcome, and the unchanged agent-run preflight as the fallback.

## Requirements

### Requirement: Candidates are retrieved by code

Preflight SHALL obtain candidate files without any model. For a given repository state and request the candidates and their excerpts SHALL be identical on every run. Retrieval SHALL return at most ten candidates, each with an excerpt of at most 600 bytes, and SHALL consider only tracked or non-ignored untracked text files of at most 2 MiB, excluding dependency directories and run logs. A file matched by the credential denylist SHALL never be a candidate.

#### Scenario: Retrieval is deterministic

- **WHEN** retrieval runs twice against the same repository state with the same request
- **THEN** both runs return the same candidates, in the same order, with the same excerpts

#### Scenario: Retrieval is bounded

- **WHEN** more than ten files match the request
- **THEN** at most ten candidates are returned and none has an excerpt longer than 600 bytes

#### Scenario: Ineligible and credential files are never candidates

- **WHEN** a matching file is ignored, binary, over 2 MiB, inside a dependency directory, or matched by the credential denylist
- **THEN** it is not returned as a candidate

### Requirement: A confident proceed skips the agent

In enforce mode, when judgment answers proceed with confidence of at least 0.80, preflight SHALL yield a proceed disposition without running the preflight agent. Its evidence SHALL be composed by code from the candidates whose relevance probability is at least 0.5, ranked by that probability, at most eight entries, each naming the path and a reason that states how the file was found and judged. Its summary SHALL be composed by code.

#### Scenario: Confident proceed composes evidence

- **WHEN** judgment answers proceed at 0.9 in enforce mode
- **THEN** preflight yields proceed with code-composed evidence and summary, and the preflight agent is not run

#### Scenario: Evidence is ranked and capped

- **WHEN** more than eight candidates are judged relevant
- **THEN** the evidence holds the eight with the highest relevance probability, in descending order

### Requirement: A confident, corroborated already-satisfied blocks without the agent

In enforce mode, when judgment answers already-satisfied with confidence of at least 0.80 and at least one candidate is judged, above 0.7, to already implement the request, preflight SHALL return the same blocked outcome that it returns today for that disposition — a summary, the evidence, and the standard question — without running the preflight agent, without creating or modifying a change, and without planning.

#### Scenario: Corroborated already-satisfied blocks cheaply

- **WHEN** judgment answers already-satisfied at 0.9 and one candidate is judged to implement the request at 0.85
- **THEN** the invocation returns the blocked outcome with the standard question, no agent is run, and no change is created

#### Scenario: Uncorroborated already-satisfied runs the agent

- **WHEN** judgment answers already-satisfied at 0.9 and no candidate is judged above 0.7 to implement the request
- **THEN** the preflight agent runs with the candidates pre-loaded

### Requirement: Clarification always runs the agent

Preflight SHALL NOT return a clarification outcome from judgment alone, at any confidence, because the clarifying question is written by the agent. When judgment answers needs-clarification, the preflight agent SHALL run.

#### Scenario: Confident needs-clarification still runs the agent

- **WHEN** judgment answers needs-clarification at 0.95 in enforce mode
- **THEN** the preflight agent runs with the candidates pre-loaded and the outcome is whatever the agent returns

### Requirement: Below the confidence floor the agent runs with the candidates

When judgment is available but does not act, the preflight agent SHALL run with the same tool-call limit and output contract as today, and its prompt SHALL additionally list the candidates' paths and excerpts.

#### Scenario: Low confidence runs the agent with candidates

- **WHEN** judgment answers with confidence below 0.80 in enforce mode
- **THEN** the preflight agent runs with the standard limit and contract and its prompt lists the candidates

### Requirement: Unavailable judgment yields today's preflight

For every unavailable reason, the preflight agent SHALL run with a prompt identical to today's and with its output parsing unchanged. When judgment is disabled, preflight SHALL perform no retrieval and no judgment work.

#### Scenario: Every unavailable reason runs today's preflight

- **WHEN** judgment is unavailable for any reason, including budget, timeout, invalid response, and model mismatch
- **THEN** the preflight agent runs with the same prompt it receives without judgment

#### Scenario: Disabled judgment adds no work

- **WHEN** judgment is disabled
- **THEN** no retrieval runs, no request is sent, no record is written, and preflight behaves as it does without judgment

### Requirement: Shadow mode always runs the agent and records agreement

In shadow mode the preflight agent SHALL run exactly as it does without judgment, with today's prompt and no candidates. The decision record SHALL hold the judged disposition and whether the decision would have acted, and SHALL be reconciled with the disposition the agent returned. Agreement SHALL be reportable, and the precision of already-satisfied — the fraction of confident judged already-satisfied dispositions that the agent also returned — SHALL be reported separately.

#### Scenario: Shadow preflight is unchanged

- **WHEN** judgment runs in shadow mode with an answer that would have acted
- **THEN** the agent runs with today's prompt and the outcome is the agent's

#### Scenario: Precision is reported

- **WHEN** the records of several shadow-mode preflights are summarized
- **THEN** the report gives agreement between judged and agent dispositions and the precision of already-satisfied

### Requirement: Skipping the agent skips its budget forecast

When the preflight agent is not run, no preflight forecast SHALL be made and none of its estimate SHALL be spent. Judgment spend SHALL be recorded, and the planning budget SHALL remain enforced for every later stage.

#### Scenario: Skipped agent consumes no preflight budget

- **WHEN** a confident proceed skips the agent
- **THEN** the planning budget shows judgment spend and no preflight agent spend, and later stages are forecast against the same budget

### Requirement: Preflight egress is documented

The security documentation SHALL list, for this decision, the state that leaves the machine: the request text and the retrieved source excerpts with their paths.

#### Scenario: Security documentation lists the preflight egress

- **WHEN** the security documentation's per-call-site table is read
- **THEN** it has a row for planning preflight naming exactly that state
