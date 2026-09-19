## Context

See `proposal.md` for motivation. The harness already treats code as the owner of workflow and models as suppliers of judgment: lifecycle state derives from a validated snapshot, spend is forecast by a budget ledger that distinguishes optional from protected activities, and every expensive stage leaves evidence in a per-change run store. What it lacks is a cheap way to make a narrow judgment, so each such decision is currently a regex or a full child agent.

The judgment service is a typed classifier. A request carries one state and a map of typed questions — choice among options, a score on an ordered rubric, or a yes/no — and the response carries one typed answer per question, with probabilities and a confidence. It generates no text. This design relies only on that contract: typed answers keyed by question identifier, per-option probabilities with a confidence for choice and score questions, a probability for yes/no questions, an echo of the model that answered, and an input-token count. The exact wire format is pinned against the service's HTTP reference while the client is built (task 2.1), not assumed here.

Three existing structures shape the design. The usage store and budget ledger key their records by change and by phase and role, so judgment spend can reuse them by adding a role and an activity. The run store keys records by a per-change run identifier, so decision records can sit beside usage records. And the total error-code classification means any new error code must be classified in the same change or typechecking fails.

## Goals / Non-Goals

**Goals:**

- One leaf library that every later integration calls, with the fail-safe, mode, audit, spend, and egress behavior specified once.
- Shadow mode that cannot be bypassed by forgetting a check at a call site.
- Records rich enough to set thresholds from data: answers, probabilities, gate outcome, and what the expensive stage actually concluded.
- Hermetic tests, including a fallback test for every unavailable reason.

**Non-Goals:**

- Any call site. No existing behavior changes here, which is what makes the change independently revertable.
- The calibration script that plots confidence against agreement. The record format is designed so it can be built on stored records, and it must exist before enforce becomes a default anywhere; enforce is never a default in this change.
- Configuration of thresholds by project. Thresholds are constants next to their decision.
- Using the layer for lifecycle transitions, digests, arithmetic, dates, or generating any text. Those stay in code.

## Decisions

### 1. A leaf library that calls nothing back

The layer lives in `src/judgment/` and is imported by phases and controllers; it imports only shared, telemetry, and persistence modules. A test scans the layer's imports and fails if any name a phase, handler, controller, agent, tool, or execution module. This matches how the controller libraries are used and prevents the cycle that would otherwise appear when the command-execution path later depends on the layer.

Alternative considered: place it under `src/controller/` beside the other decision logic. Rejected because controllers are consumed by phases and by each other, and the command-execution and review libraries that will call the layer would then sit on both sides of it.

Module layout: `client.ts` (transport), `policy.ts` (environment resolution), `egress.ts` (redaction, denylist, size), `questions.ts` and `gates.ts` (decision definitions), `ask.ts` (entry points), `usage.ts` (spend), `audit.ts` (run-store records, reconciliation, summary), `replay.ts` (recorded fixtures). The proposal's single record/replay module is split in two because "record" means two unrelated things — an audit record in the run store and a recorded fixture for tests.

### 2. Plain HTTP through the platform client, not the vendor SDK

The client uses the platform `fetch` with a pinned endpoint, bearer authentication, an overall deadline, a bounded retry on rate-limit and overload responses with jittered backoff, and the caller's cancellation signal. The engines already require Node 22 or Bun, both of which provide `fetch`.

Alternative considered: the vendor's JavaScript SDK, which retries rate limits by default. Rejected because it adds a runtime dependency to a package that is loaded as an extension into another program, its retry policy is not bounded by the caller's deadline, and faking it in tests is harder than injecting a `fetch`. The cost is a small amount of retry code, which is tested.

### 3. `judge` is the entry point; `ask` is the transport call beneath it

Two functions cover the two levels. `askJev` sends a request and returns typed answers or an unavailable result; it never throws for an operational failure. `judge` wraps it: it looks up the decision, builds its questions, asks, applies the decision's gate, records the outcome, and returns a verdict that is one of three shapes — `fallback` (unavailable; do what you do today), `shadow` (recorded; do what you do today), or `enforce` with the gate's outcome (act, or abstain). Integrations call `judge`.

The point of the verdict type is that shadow mode is a property of what the caller is handed, not of a check the caller must remember. In shadow mode the outcome is recorded but not returned, so a call site cannot act on it even by mistake. The gate's outcome is an envelope — act with a value, or abstain with a reason — so every decision is summarized the same way.

Alternative considered: return answers and mode and let each call site branch. Rejected because a forgotten branch silently enforces, and the rollout depends on shadow measurement being trustworthy.

### 4. Policy is a pure function of the environment

`MUSTER_JEV=1` and `MUSTER_JEV_API_KEY` are both required. `MUSTER_JEV_MODE` selects `shadow` (the default) or `enforce`; any other value makes judgment unavailable with an invalid-configuration reason rather than guessing, because an unrecognized value must not send content or change behavior. A decision may declare its own enabling flag; when it does, it runs only if that flag is also set, in the global mode. This is how later changes gate the two decisions that touch a correctness gate or model choice without giving them separate modes. Resolution is a pure function of an environment object so it is tested without touching the process environment.

Alternative considered: a configuration file. Deferred; the model-slot configuration already exists and is the likely eventual home, but constants and environment variables are enough for a first rollout.

### 5. One pinned model; a mismatch is unavailable

Requests name a single model version held as a constant with its per-token rate. If a response reports a different model, the request is treated as unavailable and the mismatch is recorded, because thresholds tuned against one version do not carry to another. Upgrading is therefore a deliberate change that re-runs calibration.

### 6. Decisions are typed objects, versioned, and declare their effect

A decision is an object holding its identifier, a version, its declared effects (any of: adds caution, adds advice, reduces work), an optional enabling flag, a function from typed input to questions, and a pure gate from answers to an act-or-abstain outcome. Question wording lives in `questions.ts` and thresholds in `gates.ts`, one reviewable place each, because wording is the tuning surface: the service reads questions literally, so wording changes need review like a prompt change, and negation and scoping belong in the question rather than in a comment. Later changes append their decisions to these files and do not modify each other's.

Malformed definitions raise a dedicated programming-error code identified by decision and question. The code is classified as an internal fault with no blocker, because there is nothing a user can do about it. A registry test builds every decision from representative input and validates it.

The declared effects are what make "answers never grant permission" reviewable: the vocabulary has no member that grants, and a decision that can reduce work must abstain into the full activity. A decision may declare several effects because some can both add rigor and reduce work depending on which way a confident answer points.

### 7. Records are compact, reconcilable, and summarized by a pure function

Each decision writes one JSON record under the change's run identifier, beside its usage records. A record stores the decision, version, mode, models, every answer with probabilities and confidence, the gate outcome, whether the caller acted, spend, and a digest of the redacted state — not the state itself, which would copy repository content into a second place. Full states for calibration come from the replay recorder instead.

Records are reconciled by merging observations into an `observed` map, with an agreement flag supplied by the call site, because only the call site knows how to compare its own decision with what the expensive stage concluded. The summary is a pure function over records, so the future calibration script and any report consume the same code.

The activity a decision avoided is recorded on the record by the call site, taken from the budget estimate of the skipped stage. The budget ledger's own saving field describes the skipped judgment call rather than the avoided stage, so it is not reused.

Alternative considered: persist states in records. Rejected for size and for duplicating repository content on disk under a second name.

### 8. Spend rides the existing accounting

A judgment call emits a usage record under a new `judgment` role in the caller's phase, so spend rolls up under planning, implementation, or validation naturally. The forecast uses a conservative byte-based token estimate against a new optional `judgment` budget activity, so an exhausted budget skips judgment as an optional activity does and never blocks a mandatory one. Input tokens come from the response; output tokens are recorded as zero rather than omitted. When judgment is disabled or unconfigured nothing is forecast or recorded.

### 9. Egress controls live inside the layer

Redaction applies to every string in a state. The existing manual-checkpoint redactor is not reused: it lives in the controller layer, which imports the host runner that a later change makes depend on this layer, so importing it would create a cycle; it also omits private key blocks and URL query secrets that diffs and failure output can contain, and the telemetry redactor collapses whitespace and truncates to a diagnostic length, which is wrong for a state. The layer therefore holds a redactor covering the union of those patterns. Consolidating the existing redactors onto one definition is a worthwhile follow-up, but their outputs are asserted by existing tests, so it is not part of this change.

The credential denylist works on paths, because the layer cannot tell which parts of a free-form state came from a file. Each call site lists every repository path whose content contributes to the state, and the layer refuses the request if any path matches the denylist: environment files, private key and certificate files, package-registry authentication files, and cloud or version-control credential files. The process environment has no route into a state because the layer accepts none.

Size is checked on an over-estimate of tokens (bytes divided by a small constant), against the service's per-request limits. The layer refuses instead of truncating, because truncation would change what a question means; callers excerpt.

### 10. Recording and replay; a fixture miss is loud

Fixtures are keyed by decision, version, and a hash of the canonical form of the state and of the questions, and stored under `tests/fixtures/judgment/`. The replaying client implements the same client interface as the live one. A recorder wraps a live client so a developer can capture fixtures without changing the code under test; CI never records.

A fixture miss throws a dedicated error that the entry point rethrows instead of converting to an unavailable result. This matters: if a miss were treated as unavailable, every missing fixture would look like a dead client, the fallback would run, and the test would pass while testing nothing. A separate dead-client double covers the fallback tests, one per unavailable reason.

### 11. Deadlines and retries are bounded and caller-tunable

Each request has an overall deadline, default five seconds, that covers all retries and that callers on a hot path can shorten. Rate-limit and overload responses are retried at most twice with jittered backoff inside the deadline; every other failure is not retried. The caller's cancellation signal is honored throughout.

## Risks / Trade-offs

- **New third-party egress point for repository content** → Opt-in requires two explicit variables; every state is redacted; credential-bearing paths are refused; sizes are bounded; the security documentation names what leaves at each call site before that call site ships. Redaction is best-effort, and the documentation says so.
- **Redaction patterns are duplicated a third time** → Accepted to avoid an import cycle and to avoid altering asserted outputs; consolidation is recorded as follow-up.
- **The temptation to use judgment for things it is bad at** (counting, dates, arithmetic, lifecycle) → The effect vocabulary has no grant, decisions live in a reviewed catalog, and the design's non-goals name the excluded uses.
- **A model retirement makes every call unavailable** → Everything degrades to today's behavior; the pinned constant makes the upgrade a deliberate, re-calibrated change.
- **Record volume** → Records are compact and omit the state; a per-decision cap or pruning is a later concern if volume matters.
- **Widening the usage role touches a strictly validated report schema** → The report's enumerations are extended in the same task, and existing stored usage is unaffected because it never used the new role.
- **A wrongly declared effect would mislead reviewers** → The registry test checks that effects are declared, and each integration's own change specifies its effects.

## Migration Plan

1. Widen the usage role and budget activity; add and classify the programming-error code.
2. Build the client, policy, and egress controls with their tests.
3. Add the decision registry, the audit records with reconciliation and summary, and the replay support.
4. Add the entry points with fallback tests for every unavailable reason, the shadow and enforce verdicts, and the inert-when-disabled test; add the layering test.
5. Document egress and fixtures, then run the full validation set.

The change is additive and has no call sites, so there is nothing to migrate. Rollback is reverting the change; records under a run's `judgment` directory are ignored by everything else.

## Open Questions

- Whether decision thresholds should eventually move from constants into the model-slot configuration, so a project can trade rigor for cost. This does not affect the specs or the tasks; constants are the starting point.
- Whether the per-decision summary should surface in `/change status`. A later, separate change can add it without altering the layer.
