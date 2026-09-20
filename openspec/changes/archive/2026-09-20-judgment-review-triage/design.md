## Context

See `proposal.md` for motivation. The review controller discovers the planning artifacts, computes a digest over the proposal, design, task list, and every delta specification, reads any existing review, dispatches a reviewer, recomputes the digest to detect edits made while the review ran, and persists a review artifact stamped with a round number, the reviewing model, and the digest it reviewed. The lifecycle snapshot compares that recorded digest with the current one: a match with an approve verdict means the plan is approved; a mismatch reopens the review requirement.

The review artifact records a digest, not the text it was computed from. Nothing in the harness retains the artifacts that a review approved, so there is currently no way to say what changed between an approval and the next edit. The proposal's state — the previous text, the current text, and a diff — cannot be built without adding retention.

The review artifact has a strict schema and a line-oriented rendering with fixed metadata lines and three sections; the reader requires each metadata line exactly once.

The judgment layer supplies typed decisions, shadow and enforce modes, an optional per-decision enabling flag, audit records, reconciliation, and a fallback for every unavailable reason.

## Goals / Non-Goals

**Goals:**

- Skip a repeated full review for edits that provably touch only prose the reviewer's approval did not depend on, with confidence bars and caps that make a wrong skip unlikely and bounded.
- Make every skip visible and reconstructable: what was approved, what changed, and what judgment said.
- Keep the review artifact the only lifecycle authority and keep a real reviewer as the only origin of an approval.

**Non-Goals:**

- Carrying forward a revise, or across any specification or task-list change.
- Carrying forward more than three consecutive edits.
- Using judgment to decide anything about verification, finishing, or any gate other than repeating a planning review.
- Retaining or sending artifact text beyond the proposal and the design.

## Decisions

### 1. Eligibility is decided by code, and judgment sees only eligible edits

A pure function compares the current artifacts with the retained approved copy and the existing review, and returns either the reason the edit is ineligible or the list of changed prose files. The conditions are exactly those in the specification. Judgment is consulted only for an eligible edit, so a specification edit, a task-list edit, a revise, a missing copy, a fourth edit, or an edit with extra instructions never generates egress and never depends on a model.

Explicit review instructions bypass triage. A person who types guidance after the review command wants the reviewer to look at something, and this gives them a way to force a real review without a new command-line flag.

### 2. Retention is per file digests plus the two prose files' text

When triage is enabled and a review approves, the controller stores a snapshot under the change's run: the artifact digest, a digest for every reviewed file, and the text of the proposal and the design only. Digests for the rest are enough to detect that a specification or task list changed, added, or removed; the text of those files is never retained or sent. At most the three most recent snapshots are kept. Retaining only when triage is enabled means users who never enable it store nothing, and the first edit after enabling it gets a full review because no snapshot exists yet — a safe bootstrap.

Alternative considered: obtain the previous text from version control. Rejected because planning artifacts are frequently uncommitted, and a commit boundary is not an approval boundary.

### 3. A small deterministic diff helper

A pure line-based unified diff with five lines of context turns the retained text and the current text into what the judgment sees. The state is the diffs, not the two full texts, because the questions are about the change, the diff carries it, and it keeps egress and size down. The total is capped at 16,000 bytes; more is unavailable, which means a full review, and an edit that large is not the kind this is for.

### 4. Six questions, a conjunctive gate, and one declared effect

One rubric asks how much the change alters what is being proposed, from wording only to a change of scope, architecture, or a design decision, with an instruction to judge the substance rather than the size of the diff. Five yes/no questions ask whether the edit changes requirements, scenarios, tasks, or scopes, or contradicts what the approval or its recommendations relied on. The state includes the previous review's recommendations for the last question.

The gate is a conjunction: materiality below 1.5 at confidence 0.85, and every yes/no probability below 0.25. Any failure abstains into a full review. The thresholds are constants beside the gate and are starting points. Requirement, scenario, task, and scope questions are redundant with the eligibility rule that excludes those files, on purpose: prose in the design can restate a requirement, and a second line of defense costs one question.

The decision declares one effect: it reduces work by skipping a review, and it falls through to the full review whenever it abstains.

### 5. The carried-forward artifact is honest about its origin

A carry-forward writes a new review artifact for the current digest: verdict approve, the round incremented, the reviewing model of the basis review, and the basis review's recommendations preserved. Optional fields add the basis digest, the running count, and the decision record, and an evidence section lists the judged answers. The model field stays the basis reviewer's because the approval is that reviewer's; the added marks say how the approval reached this digest. No field claims that a model reviewed the current text.

Lifecycle consumers read the verdict, the digest, and the lists, all unchanged, so they treat it as an ordinary current approval. The change state and the digest binding stay the single source of authority. The new fields are optional in both directions, so earlier artifacts parse as full reviews. The optional-line reader added for the extraction change's provenance mark is reused if it already exists, and added here if it does not.

### 6. The one gate a model can affect, so every safeguard is stacked

This is the only integration in which a model's answer can decide whether a correctness gate runs, so the safeguards are cumulative rather than any one of them being trusted: an explicit flag on top of the global opt-in; scope limited to two prose files; approve only; a cap of three; a conjunctive gate with a high bar; provenance recorded in the artifact and stated in the command's outcome; and shadow measurement before any of it acts. A wrong skip in the worst case lets a prose-only edit that materially changed the plan pass one review that would have caught it, with the run's own later gates — task review, verification — still in place.

### 7. A digest race falls back to a full review

Triage takes the digest at its start and rechecks it after judgment returns, exactly as the reviewer path rechecks after the reviewer. A change during triage means no carry-forward and a full review.

### 8. Shadow measures the question the rollout turns on

In shadow mode the reviewer always runs. The decision record is reconciled with the review's verdict and its count of required changes. A false skip is a decision that would have carried forward followed by a review that did not approve. The report counts eligible edits, would-have-carried edits, and false skips; the rollout question — how often does a judged-immaterial edit turn out to change a verdict — is read directly from it.

### 9. The outcome says what happened

A carry-forward returns the same next step as an approval, and the review phase's outcome states that the review was carried forward, from which basis, how many times, and how to obtain a full review.

## Risks / Trade-offs

- **A false skip lets a materially changed plan through one review** → The stacked safeguards above; bounded blast radius; later gates remain; shadow data before enforce.
- **Accumulated immaterial edits drift far from what was approved** → The cap of three consecutive carry-forwards, and the comparison is always against the last real review's copy, not the previous carry-forward's.
- **A carried-forward review misread as a fresh one** → Explicit marks in the artifact, an evidence section, and a statement in the outcome.
- **Snapshot storage growth** → Only two prose files' text plus digests, only when enabled, only three kept.
- **Design prose that restates requirements** → The requirement, scenario, task, and scope questions exist for this case.
- **Review artifact schema change** → Optional fields, round-trip and older-artifact tests.
- **Edits are in flight in the controller, artifact, and phase** → Implement on top of them.

## Migration Plan

1. Add snapshot retention and the diff helper with their tests.
2. Extend the review artifact with the optional carry-forward marks.
3. Add the eligibility function; register the decision with its state builder and gate.
4. Integrate triage into the review controller, including retention on approval, the digest recheck, and shadow reconciliation.
5. Wire the review phase and its outcome message, and test that lifecycle derivation accepts a carried-forward approval.
6. Add the false-skip report, the documentation row, and run the full validation set.

Rollout: enable the triage flag together with judgment in shadow mode; let several dozen real edits accumulate; read the report; enable enforce only if false skips are essentially absent. Rollback: unset the flag, or revert; retained snapshots are ignored, and carried-forward artifacts remain valid approvals.

## Open Questions

- Whether a future version should include task-list prose edits that leave every task definition unchanged. It would widen the eligibility requirement, so it would be a specification change at that time.
