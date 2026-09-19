## 1. Groundwork

- [x] 1.1 Add `judgment` to the usage roles and to the optional budget activities, and extend the telemetry report's role and activity enumerations to accept them; verify with tests that a usage record under the judgment role aggregates with the others, that a forecast for the judgment activity that exceeds a budget is skipped as optional and never blocks a mandatory activity, and that the report accepts judgment usage.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/telemetry/**", "src/agents/model-router.ts", "tests/telemetry/**"]
  writes: ["src/telemetry/usage.ts", "src/telemetry/budget.ts", "src/telemetry/report.ts", "tests/telemetry/**"]
  requirements: ["judgment-layer: Judgment spend is visible in existing accounting"]
  scenarios: ["Usage is recorded for every judgment call", "Budget exhaustion skips judgment"]
  verify: ["bun test tests/telemetry", "bun run typecheck"]
  manual: null
  ```

- [x] 1.2 Declare `JUDGMENT_QUESTION_INVALID` in the harness error codes and classify it as an internal fault with no blocker in the total classification; verify typechecking passes and the existing command and classification tests still pass.

  ```yaml harness-task
  id: "1.2"
  dependsOn: []
  role: builder
  reads: ["src/shared/errors.ts", "src/change/failure-classification.ts", "tests/muster/**", "tests/commands/**"]
  writes: ["src/shared/errors.ts", "src/change/failure-classification.ts"]
  requirements: ["judgment-layer: Malformed question definitions are programming errors"]
  scenarios: ["Duplicate question identifiers"]
  verify: ["bun run typecheck", "bun test tests/muster tests/commands"]
  manual: null
  ```

## 2. Transport and Safety

- [x] 2.1 Implement the judgment client in `src/judgment/client.ts`: a client interface, a `fetch`-based implementation holding the pinned model and per-token rate as constants, an overall deadline, at most two jittered retries on rate-limit and overload responses, cancellation, and response validation pinned against the service's HTTP reference with a recorded sample response; verify with tests over an injected `fetch` covering success, a retry that recovers, exhausted retries, a server failure, a deadline, cancellation, a malformed or partial response, a value outside the supplied options, and a reported model that differs from the pinned one.

  ```yaml harness-task
  id: "2.1"
  dependsOn: []
  role: builder
  reads: ["src/telemetry/usage.ts", "src/shared/**"]
  writes: ["src/judgment/client.ts", "tests/judgment/client.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-layer: Operational failures degrade to existing behavior", "judgment-layer: The model is pinned and every decision is recorded"]
  scenarios: ["Service unreachable", "Deadline elapses", "Rate limit persists", "Response is unusable", "Caller cancels", "Pinned model is requested", "Reported model differs"]
  verify: ["bun test tests/judgment/client.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 2.2 Implement policy resolution in `src/judgment/policy.ts` as a pure function of an environment object: both `MUSTER_JEV=1` and `MUSTER_JEV_API_KEY` required, `MUSTER_JEV_MODE` of shadow by default or enforce, an unrecognized mode reported as invalid configuration, disabled distinguished from not configured, and support for a decision's own enabling flag; verify with table-driven tests over every combination of the variables.

  ```yaml harness-task
  id: "2.2"
  dependsOn: []
  role: builder
  reads: ["src/shared/**"]
  writes: ["src/judgment/policy.ts", "tests/judgment/policy.test.ts"]
  requirements: ["judgment-layer: Mode determines whether a decision acts", "judgment-egress: Judgment is opt-in"]
  scenarios: ["Default mode is shadow", "Unrecognized mode is unavailable", "Neither variable is set", "Flag without a key", "Key without the flag", "Both are present"]
  verify: ["bun test tests/judgment/policy.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 2.3 Implement egress controls in `src/judgment/egress.ts`: redaction of every string in a state covering bearer credentials, credential flags, `key: value` secrets, private key blocks, and secret-bearing URL query parameters; a path denylist for environment files, private key and certificate files, package-registry authentication files, and cloud and version-control credential files, applied to the paths a call site declares; and conservative token estimation with the 32,000-token and 64,000-token limits; verify with tests for each redaction pattern, each denylist family, an allowed source path, both size limits, and that a state is never truncated.

  ```yaml harness-task
  id: "2.3"
  dependsOn: []
  role: builder
  reads: ["src/controller/manual-checkpoint.ts", "src/telemetry/redaction.ts"]
  writes: ["src/judgment/egress.ts", "tests/judgment/egress.test.ts"]
  requirements: ["judgment-egress: Secrets are redacted before leaving the machine", "judgment-egress: Credential files and the environment are never sent", "judgment-egress: State size is bounded and never silently truncated"]
  scenarios: ["Bearer credential in failure output", "Credential flag in a command", "Environment file content is denied", "Credential file content is denied", "Ordinary source content is allowed", "State too large for the longest question", "State too large for all questions", "State within limits"]
  verify: ["bun test tests/judgment/egress.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Catalog, Audit, and Replay

- [x] 3.1 Implement the decision registries in `src/judgment/questions.ts` and `src/judgment/gates.ts`: helpers for choice, score, and yes/no questions, the typed decision object holding identifier, version, declared effects, optional enabling flag, question builder, and a pure gate returning an act-or-abstain envelope, validation that raises `JUDGMENT_QUESTION_INVALID` for malformed definitions, and a registry test that builds and validates every registered decision from representative input using a test-only sample decision; verify the tests cover a duplicate identifier, an unsupported type, a choice without options, a rubric without criteria, an empty question, a missing effect declaration, an effect that grants, an uncertain-band abstention, and a version change.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/shared/errors.ts", "src/judgment/**"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "tests/judgment/catalog.test.ts"]
  requirements: ["judgment-layer: Malformed question definitions are programming errors", "judgment-layer: Uncertainty falls through to existing behavior", "judgment-layer: Answers never grant permission"]
  scenarios: ["Duplicate question identifiers", "Every catalogued decision is validated", "Answers fall in the uncertain band", "Changing a decision changes its version", "Every decision declares its effects"]
  verify: ["bun test tests/judgment/catalog.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 3.2 Implement decision audit records in `src/judgment/audit.ts` beside the usage records in the run store: a versioned record schema holding the fields the specification names plus a digest of the redacted state, write and list operations keyed by the change's run identifier, reconciliation that merges observations and reports a missing record without raising, and a pure per-decision summary; verify with tests for the record round trip, merged reconciliation, a missing record, and summaries that separate would-have-acted from acted and exclude unreconciled records from agreement.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/persistence/**", "src/telemetry/usage.ts"]
  writes: ["src/judgment/audit.ts", "tests/judgment/audit.test.ts"]
  requirements: ["judgment-layer: The model is pinned and every decision is recorded", "judgment-layer: Records can be reconciled with what actually happened", "judgment-layer: Decisions are summarized for calibration"]
  scenarios: ["Decision record contents", "Unavailable result is recorded", "Reconciled after the fact", "Repeated reconciliation merges", "Reconciling a missing record is harmless", "Summary reports per decision", "Would have acted is distinct from acted", "Unreconciled records are excluded from agreement"]
  verify: ["bun test tests/judgment/audit.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 3.3 Implement recorded-fixture support in `src/judgment/replay.ts`: canonical serialization, fixture keys from decision, version, and hashes of the state and the questions, a replaying client that throws a dedicated fixture-missing error, a recorder that wraps a live client, a dead-client double with a selectable unavailable reason, and the fixtures directory; verify with tests that a matching recording is replayed, that differing content misses, that a miss throws instead of yielding an unavailable result, and that the dead client yields each reason.

  ```yaml harness-task
  id: "3.3"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/judgment/**"]
  writes: ["src/judgment/replay.ts", "tests/judgment/replay.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-layer: Tests never reach the network"]
  scenarios: ["Recorded response is replayed", "Missing recording fails the test", "Different content is a different recording"]
  verify: ["bun test tests/judgment/replay.test.ts", "bun run typecheck"]
  manual: null
  ```

## 4. Entry Points

- [x] 4.1 Implement the entry points and the runtime in `src/judgment/ask.ts` and `src/judgment/usage.ts`: the transport call that never throws for an operational failure and rethrows a fixture-missing error, the decision entry point returning the fallback, shadow, or enforce verdict, a runtime built from the environment with budget and store injection plus an inert runtime for the disabled case, the usage emission and budget forecast, and the audit write; verify with tests that every unavailable reason yields the fallback verdict without an error, that shadow returns no outcome while enforce returns the gate's outcome, that a disabled runtime performs no I/O, that usage is recorded whether or not the decision acts, that an exhausted budget skips the request, that the API key never appears in a record or fixture, and that no part of the process environment appears in a sent state.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["1.1", "2.1", "2.2", "2.3", "3.1", "3.2", "3.3"]
  role: builder
  reads: ["src/judgment/**", "src/telemetry/**", "src/persistence/**"]
  writes: ["src/judgment/ask.ts", "src/judgment/usage.ts", "tests/judgment/ask.test.ts"]
  requirements: ["judgment-layer: Operational failures degrade to existing behavior", "judgment-layer: Disabled judgment is inert", "judgment-layer: Mode determines whether a decision acts", "judgment-layer: Judgment spend is visible in existing accounting", "judgment-layer: The model is pinned and every decision is recorded", "judgment-egress: Secrets are redacted before leaving the machine", "judgment-egress: Credential files and the environment are never sent"]
  scenarios: ["Service unreachable", "Judgment disabled performs no work", "Shadow mode does not hand over an outcome", "Enforce mode hands over an acting outcome", "Usage is recorded for every judgment call", "Budget exhaustion skips judgment", "The API key is never persisted", "The process environment is never included"]
  verify: ["bun test tests/judgment/ask.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 4.2 Add the layering test that scans the layer's imports and fails if any names a phase, handler, controller, agent, tool, or execution module, and a fallback test that runs the entry point with the dead-client double for every unavailable reason and asserts the caller-visible result is the fallback each time; verify both pass.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1"]
  role: builder
  reads: ["src/judgment/**", "tests/muster/module-layout.test.ts"]
  writes: ["tests/judgment/layering.test.ts", "tests/judgment/fallback.test.ts"]
  requirements: ["judgment-layer: The layer is a library that calls nothing back", "judgment-layer: Operational failures degrade to existing behavior"]
  scenarios: ["Layer dependencies are restricted", "Service unreachable", "Response is unusable"]
  verify: ["bun test tests/judgment", "bun run typecheck"]
  manual: null
  ```

## 5. Documentation and Validation

- [x] 5.1 Add a judgment-egress section to `docs/security.md` covering third-party egress, the opt-in variables, best-effort redaction, the credential denylist, size limits, the provider's stated data-handling posture with a note to confirm retention arrangements for proprietary code, and a per-call-site table that starts with no rows and that each later change extends; add a recorded-fixtures note to `docs/testing.md`; verify the documentation checks pass with the required host-execution wording intact.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["4.2"]
  role: builder
  reads: ["docs/**", "scripts/docs/check.ts", "src/judgment/**"]
  writes: ["docs/security.md", "docs/testing.md"]
  requirements: ["judgment-egress: Egress is documented before it ships"]
  scenarios: ["Security documentation names the egress", "Documentation checks pass"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [x] 5.2 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that no behavior changed with judgment disabled and that the layer has no call sites in any phase.

  ```yaml harness-task
  id: "5.2"
  dependsOn: ["5.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-layer: Disabled judgment is inert", "judgment-layer: The layer is a library that calls nothing back"]
  scenarios: ["Judgment disabled performs no work", "Layer dependencies are restricted"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
