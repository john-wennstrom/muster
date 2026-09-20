## Context

See `proposal.md` for motivation. The per-task review step reads the task's diff and its source digest from the task's worktree, then dispatches a reviewer through the task code-review dispatcher. The dispatcher selects a reviewer model, prefers one different from the author's, creates a fresh session, renders a prompt from the task contract, the diff summary, the test evidence, the authorized scopes, and the test-first evidence, runs the reviewer in a read-only mode, audits the tools it used, and validates that the returned review matches the run, the task, the reviewer model, and the source digest. Approval derives from the returned review: any required finding makes the decision a repair.

At this call site the scopes' violation list is always empty, because no code computes it. The diff summary is the full diff text, which can be large.

The judgment layer supplies typed decisions, shadow and enforce modes, audit records, and a fallback for every unavailable reason. The step context that carries the run's store, model stack, and progress observer is the natural place to carry the judgment runtime.

## Goals / Non-Goals

**Goals:**

- Point the reviewer at the areas most likely to matter, using only inputs the step already has.
- Change nothing about who decides, what runs, or what is validated.
- Make the effect on finding counts measurable against an unfocused baseline.

**Non-Goals:**

- Skipping or replacing the reviewer for any task. That is a different change with a flag, a conjunction of thresholds, and its own risk.
- Computing scope violations. That is a deterministic fact that belongs in code, noted below as a follow-up.
- Passing model-written text to the reviewer. Focus is selected phrases only.

## Decisions

### 1. The hint is an optional, advisory block in the existing prompt

The dispatcher's options gain an optional list of focus items. When the list is empty or absent the prompt is byte-for-byte what it is today; when present the renderer adds one block before the closing instruction. Nothing else about the dispatcher — reviewer selection, session isolation, tool audit, validation of the returned review — changes.

### 2. A catalogue of phrases, thresholds, and a priority order

Each question maps to one fixed phrase and one threshold, and the mapping lives with the gate. A question that should be true for a good change produces its phrase when its answer falls below 0.3; a question that should be false produces its phrase above 0.7; the reach rubric produces its phrase at 2.0 or above with confidence 0.7. Uncertain answers produce nothing, so uncertainty costs the reviewer no attention rather than misdirecting it.

The priority order, used to cap at four items, runs from most to least consequential: security-boundary changes, changes outside the declared scopes, divergence from the contract, tests that miss scenarios, inconsistent test-first evidence, stubs or hard-coded values, and impact outside the diff. The order is a constant beside the catalogue.

### 3. The state reuses what the step already assembled, with the diff excerpted

The state is the contract, the diff excerpt, the test evidence, the scopes, and the test-first evidence. The diff excerpt is the leading part of the diff up to 24,000 bytes cut at a file boundary, and the state also carries the complete changed-path list, parsed from the diff headers, so questions about which files changed do not depend on the excerpt. Every changed path is declared to the layer for the credential denylist. If any changed path is denied, the request is unavailable and the reviewer receives no hint; the reviewer itself is a local agent and still sees the full diff as it does today.

### 4. Scope containment is asked here, and should be computed in code later

Whether every changed file falls inside the declared write scopes is a deterministic fact, and the layer's own guidance is that deterministic facts stay in code. The scopes' violation list is empty at this call site today, so nothing computes it. This change still asks the question, because the answer only shapes an advisory hint and a wrong answer misdirects at worst one reviewer, but the right fix is a code-computed violation list that then feeds the focus directly. That is recorded as a follow-up rather than done here, because it is a separate, testable behavior with its own specification.

### 5. Effects and measurement

The decision adds advice only. Shadow mode leaves the prompt unchanged and records the focus that would have been given; after the review, the record is reconciled with the reviewer's finding counts by severity, the areas raised, and which focus items named an area the reviewer raised. A report helper compares mean finding counts between reviews that received a focus list and reviews that did not, and reports the share of items that named a raised area.

Shadow supplies the unfocused baseline, and enforce runs supply the focused group, so the rollout gate — finding counts hold or improve — is read from the comparison. Reviewer duration is available separately from the existing usage records and can be joined by task if it is wanted.

### 6. The runtime rides the step context

The judgment runtime is an optional field on the task step context, added by this change if no earlier change has added it. The review step reads it from there; tests inject a replaying or dead client.

## Risks / Trade-offs

- **A misleading hint anchors the reviewer away from a real defect** → The block is advisory, says to disregard it where the diff does not support it, is capped at four fixed phrases, and is compared against an unfocused baseline before enforce is used.
- **The excerpt hides the part of the diff that matters** → The complete changed-path list is always present, and a state that cannot be sent leaves the prompt unchanged.
- **Test output carries incidental secrets** → Redaction is applied to the whole state, and the documentation names test output specifically.
- **Scope containment is judged instead of computed** → Acceptable for an advisory hint; recorded as a follow-up.

## Migration Plan

1. Add the optional focus list to the dispatcher's options and rendering, with byte-identical output when absent.
2. Register the decision with its catalogue, thresholds, priority, and cap.
3. Wire the call into the review step, with shadow, enforce, fallback, and gate-invariance tests, and add the comparison report.
4. Add the documentation row and run the full validation set.

Rollout: shadow first for a baseline of finding counts, then enforce, then compare. Rollback: unset the enabling flag, or revert, which removes one call and one optional prompt block.

## Open Questions

- Whether reviewer duration should join the comparison report. Affects only the report.
