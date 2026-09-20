## Context

See `proposal.md` for motivation and for the boundary that shapes this change: the loop that records failures does not exist in production yet.

The debugging policy keeps a per-task state: a threshold, a mode, the failures so far, and an optional investigation. Each failure holds an attempt number, a reproduction, a non-empty list of evidence strings, and a timestamp. The state's schema derives the mode from the count: it rejects any state whose mode is not systematic debugging exactly when the number of failures has reached the threshold. Recording a failure in systematic mode is an error, and an investigation may begin only in systematic mode. No production code calls any of this, and the task pipeline ends a failed verification or review as blocked rather than retrying.

That schema rule is the design's central constraint. Flipping to systematic debugging before the threshold would produce a state the schema rejects, so early escalation needs an explicit, validated representation rather than a quiet mode change.

The judgment layer supplies typed decisions, shadow and enforce modes, audit records, reconciliation, and a fallback for every unavailable reason.

## Goals / Non-Goals

**Goals:**

- Detect a loop that is not converging, and one that needs a human, after each failure.
- Guarantee by construction and by a property test that judgment can only shorten a loop.
- Keep every existing state valid and every existing transition unchanged when judgment does not act.

**Non-Goals:**

- Adding a repair loop or connecting the policy to task execution. That is a roadmap item.
- Creating the manual checkpoint for a human-needed decision. The assessment returns the decision; the loop that calls it creates the checkpoint through the existing manual-checkpoint machinery, which a policy module should not import.
- Judging counts, dates, or attempt arithmetic. The count stays in code.

## Decisions

### 1. Early escalation is an explicit, validated field

The state gains an optional escalation: its reason, the attempt at which it occurred, and the decision record that supported it. The mode derivation becomes "systematic when the count has reached the threshold, or when an escalation is recorded". Two invariants keep it from ever lengthening anything: an escalation is valid only at an attempt below the threshold, and only at the latest recorded failure, since ordinary repair is disabled from that point and no further failure can follow. Existing states have no escalation and derive their mode exactly as before.

Alternative considered: lower the state's threshold to the current count when escalating. It fits the existing derivation without a new field, but it overwrites the configured threshold and loses the audit trail of why the task moved. Rejected.

### 2. Failures record the attempted fix

The failure record gains an optional attempted fix: a short description of what the builder changed in the attempt that produced this failure. The question of whether a fix made progress cannot be answered without it, so an assessment requires it, and an absent value means no assessment. It is optional so existing states stay valid.

### 3. Assessments are stored as observations, in both modes

Each assessment — the attempt it followed, the judged probabilities, and the decision record — is appended to an optional list in the state. This is what makes "two consecutive rounds" computable from the state alone. They are stored in shadow mode too, because they are observations like the failures themselves; only the escalation is mode-dependent, and it is recorded only in enforce mode. Transitions in shadow mode therefore follow the count, while the decision record shows what enforce would have done.

### 4. Pure functions decide; one asynchronous step assesses

Three pure functions carry the logic: one appends an assessment, one decides the next path from the state and the latest assessment, and one applies an early escalation. The decision function returns continue, escalate, or await the user, with precedence to awaiting the user. An asynchronous step builds the state for judgment, calls it, and returns the assessment and the decision. Keeping the logic pure makes the property test — for every failure history and every sequence of assessments, the attempt at which the mode becomes systematic is never later than the count-based one — cheap to run over many cases.

### 5. Bands and the consecutive-round rule are constants beside the gate

A round is stalled when the same-root-cause probability is above 0.8 and the progress probability is below 0.3; two consecutive stalled rounds escalate; a human-needed probability above 0.8 awaits the user. The remaining answers — whether the failure changed, whether the defect has been located, and a rubric on how well the fix matched the evidence — are recorded but not gated, to build calibration data. All bands are starting points.

With a small threshold the rule can never fire earlier than the count would: two stalled rounds need at least three failures, so the rule matters only for thresholds above three. That is a property of the rule, and the calibration data will show whether a single stalled round should suffice for larger thresholds.

### 6. Failure text is bounded by the caller and redacted by the layer

Evidence strings, the reproduction, and the attempted fix are excerpted by the recording code to fixed byte limits, since the layer never truncates. Failure evidence is where secrets leak, because it is command output, so this is the call site where redaction matters most, and the documentation says so.

### 7. Shadow reconciles with the eventual outcome

When the task passes or exhausts its attempts, the record of each shadow decision is reconciled with the outcome and the attempt at which it occurred. That shows whether tasks that shadow would have escalated early went on to pass later, which is the fairness question for early escalation.

### 8. The decision declares two effects

Escalating early reduces work, by cutting attempts, and stopping for a human adds caution. Neither grants anything, and both only ever shorten a loop.

## Risks / Trade-offs

- **A wrongly early escalation** → The cost is one attempt fewer than the count would have allowed, and a visible, resumable move to systematic debugging. Two consecutive stalled rounds are required, and shadow data measures the fairness first.
- **A wrongly stopped loop for a human** → A visible checkpoint with a reason; the same decision can be reviewed in shadow data before enforce.
- **Secrets in failure output** → Redaction, byte caps, and documentation that names the field.
- **State schema change** → Every new field is optional and every invariant only constrains states that use the new fields; existing states and their tests are unaffected.
- **Dormant until wired** → Stated in the proposal; the property and shadow tests cover the logic meanwhile.

## Migration Plan

1. Extend the failure state and its mode derivation with backward-compatibility tests.
2. Add the pure functions with the property test that judgment never lengthens a loop.
3. Register the decision and add the assessment step with its fallback, shadow, and redaction tests.
4. Add the documentation row and run the full validation set.

There is nothing to migrate because no production path writes this state. Rollback is reverting the change. When the repair loop is wired, that work calls the assessment step and enables shadow mode first.

## Open Questions

- Whether a single stalled round should suffice for large thresholds once calibration data exists. It would change the escalation requirement, so it would be a specification change at that time.
