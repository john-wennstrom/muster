## Context

See `proposal.md` for motivation. In the planning phase, preflight runs first and yields evidence paths. The phase then computes four risk booleans from the effective request text with pattern matches, passes them with the affected files and capabilities to the complexity classifier, and hands the resulting classification to the planning controller. The effective request is the user's prompt plus, on refinement, the required changes from a pending REVISE review.

The classifier assigns each signal a severity: data migration, security boundary, and design ambiguity are high; public contract is medium; file and capability counts are graded. Any high signal classifies the change as architectural, which enables specialist opinions and a debate at the configured architect thinking level. Any medium signal classifies it as bounded, at medium thinking; otherwise it is direct, at low thinking. Overrides, from the user or the controller, require an auditable reason and take precedence over the computed classification.

The judgment layer supplies typed decisions with per-decision confidence bands, shadow and enforce modes, audit records, and a fallback for every unavailable reason. This change adds one decision to it and one call site in the planning phase.

## Goals / Non-Goals

**Goals:**

- Correct the four inputs where a confident judgment disagrees with the pattern, in both directions.
- Produce exactly today's classification whenever judgment is unavailable, in shadow mode, or not confident about a signal.
- Make disagreement between judgment and patterns measurable per signal before enforce is used.

**Non-Goals:**

- Changing the severity ladder, the thresholds on file and capability counts, or the orchestration policy.
- Judging the classification itself, or choosing thinking levels directly from judged values.
- Feeding the recorded-only signals into any decision. They exist to build the calibration corpus.
- Judging complexity in any phase other than planning.

## Decisions

### 1. Only the four inputs change

The classifier and the orchestration policy stay byte-for-byte as they are. The judged values replace the four booleans that feed the classifier, and nothing else. This bounds the blast radius to inputs the classifier already accepts, leaves overrides and their audit reason untouched, and means every existing classifier test remains valid.

Alternative considered: judge the classification directly (direct, bounded, or architectural). Rejected because the severity ladder is deterministic, reviewed, and auditable, and a calibrated judgment about four narrow facts is easier to threshold and to audit than one about an aggregate.

### 2. Extract the pattern rules and put the merge beside them

The four pattern expressions move, unchanged, out of the planning phase into a small pure module in the controller layer, next to a pure merge function that takes the pattern values, the confident judged values, and the phase. Two reasons. The fallback must be provably identical to today, and a test can compare the extracted function against the original expressions over a table of prompts, including both known failure prompts. And the merge, including the refinement-only scoping of design ambiguity, becomes table-testable without a planning run. The classifier's own module is not edited.

### 3. One call, after preflight, over the state the classifier already has

The call sits between preflight and classification because by then the evidence paths and reasons exist. The state is the effective request, the phase, the evidence entries, and the affected paths; the evidence paths are declared to the layer so the credential denylist applies to them. All six questions ride in one call, since they share a state and batching is cheaper than separate calls.

This call is deliberately separate from the preflight judgment that a later change introduces. That call's state is the request and candidate excerpts before evidence is composed, and this call's state includes the composed evidence, so they cannot share a request. Merging them once retrieval moves into code is an optimization to consider after both have shadow data, and it changes neither specification.

### 4. A per-signal gate returns the confident subset

The decision's gate maps each of the four answers to true above 0.7, false below 0.3, and abstains for that signal otherwise. The gate's outcome is the mapping for the confident signals only; a signal absent from the outcome takes its pattern value in the merge. The decision as a whole acts when at least one signal is confident and abstains when none is. The bands are constants beside the gate and are starting points to be set from shadow data, not recommendations.

### 5. The decision declares two effects

A confident yes that the pattern missed adds rigor: more orchestration, more spend. A confident no that the pattern got wrong removes work. The decision therefore declares both effects. Both are bounded by the classifier's ladder and by overrides, and both fall through to the pattern value when the judgment is not confident, so uncertainty costs what it costs today.

### 6. Question wording carries the scoping rules

The service reads questions literally, so each question states its own boundary. The migration question requires a migration and says a request that explicitly avoids one answers no. The public-contract question limits itself to externally observable interfaces and excludes internal function signatures. The security question is limited to what an actor may do or what is trusted. The ambiguity question asks whether two incompatible designs would both be reasonable readings. The two recorded-only questions are a yes/no on whether the change follows a stated pattern without design judgment and a four-level rubric on how far it reaches. Wording is versioned with the decision, so a change to it invalidates recordings.

### 7. Design ambiguity is asked always and applied only in refinement

Today the ambiguity pattern applies only when refining. Applying a judged ambiguity in proposals would broaden when architectural orchestration triggers beyond anything the pattern could do, and an ambiguous proposal is already handled by preflight's clarification outcome. The merge therefore applies the judged value only in refinement. The question is still asked in every phase and recorded, so shadow data shows how often proposals would have been affected.

### 8. Shadow reconciles immediately

The record is reconciled as soon as the pattern values are computed: the observed value for each signal is the pattern value, and agreement means every confident signal equals its pattern value. There is no later stage to wait for, because the pattern is the baseline being compared against. A small report helper reads these records and reports each signal's agreement rate, the direction of disagreement (judgment says yes where the pattern says no, or the reverse), and the number of changes measured.

Disagreement is not error. It is the review queue: someone must read the disagreements and decide which side was right before the rollout gate is considered met.

### 9. The runtime is injected, defaulting to one built from the environment

The planning options gain an optional judgment runtime, alongside the existing injection points for the budget, the OpenSpec adapter, and the preflight runner. Absent one, the phase builds it from the environment using the planning budget ledger and the change's stores, so judgment spend counts against the planning budget. Tests inject a replaying or dead client. The phase depends on the judgment library, which is the permitted direction.

## Risks / Trade-offs

- **Miscalibrated bands** → Shadow first, and enforce only after agreement is measured across at least twenty changes and the disagreements are reviewed. Bands live in one place and change with the decision's version.
- **A confident false yes escalates a change** → Bounded by the same roughly $0.27 that a pattern false positive costs today, and an override remains available.
- **Literal reading of negation and scope** → Wording states each rule; recorded responses for both known failure prompts are part of the tests.
- **Added latency** → About 150 milliseconds in a phase that runs for minutes.
- **The extracted pattern function drifts from the original** → A table test compares it with the original expressions before the original is removed.
- **Edits are in flight in the planning phase module** → Implement on top of them and rebase rather than reapply.

## Migration Plan

1. Extract the pattern rules and add the pure merge with its tests.
2. Register the decision with its questions, bands, and wording tests.
3. Wire the call into the planning phase behind the runtime, with shadow, enforce, and fallback tests.
4. Add the per-signal agreement report.
5. Add the documentation row and run the full validation set.

Rollout: enable judgment in shadow mode on real planning runs, read the per-signal report after at least twenty changes, review the disagreements, and only then enable enforce for this decision. Rollback: unset the enabling flag, or revert the change, which removes one call and leaves the pattern-only behavior.

## Open Questions

- Whether the bands should differ per signal once shadow data exists, for example stricter for security boundary. This affects only the gate's constants and the decision's version.
