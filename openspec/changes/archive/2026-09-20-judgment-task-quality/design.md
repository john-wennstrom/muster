## Context

See `proposal.md` for motivation. Synthesis returns one bundle of artifacts as JSON. The planning phase's artifact-writing dependency parses and validates the bundle's shape, requires the proposal, design, task list, and at least one specification, and writes every file. The task list is later parsed by the task parser and validated by the task schema, which checks structure and references, and the review phase discovers the artifacts and digests them.

Task completion state lives in the same file as the task definitions: implementing a task ticks its checkbox, so the file's digest changes during implementation. Anything keyed to a whole-file digest would detach from its tasks as work proceeds.

The planning review is written by a reviewer agent; the controller stamps its bookkeeping fields and persists the artifact. Nothing else authors review content, and the design keeps it that way.

The judgment layer supplies typed decisions, shadow and enforce modes, audit records, reconciliation, and a fallback for every unavailable reason.

## Goals / Non-Goals

**Goals:**

- Flag likely task defects while they are still a sentence to fix.
- Keep the reviewer the sole author of the review, and keep planning's written artifacts identical.
- Make the value measurable: findings against real task outcomes.

**Non-Goals:**

- Rewriting or repairing tasks. Judgment generates nothing, and a repair is a synthesis job.
- Replacing the structural validation, which stays exactly as it is.
- Counting, sizing by measurement, or graph analysis. Counts and graph properties are computed by code where they are needed.
- Judging anything at implementation time; the implementation phase only records outcomes.

## Decisions

### 1. Assess inside the artifact-writing step, from the in-memory bundle

The assessment runs where the bundle is already parsed and validated, before files are written, over the exact content that will be written. It uses the existing task parser and validator on the bundle's task list; if either rejects it, the assessment is skipped and writing proceeds as today, because reporting a malformed task list is the review's and the snapshot's job. Any error raised by the assessment itself is swallowed into a skip: it must never fail or delay writing. The findings are captured in a local variable the phase reads after planning returns.

### 2. The state is built from the bundle by a pure function

A pure function in the controller layer turns the bundle into the state: a change summary excerpt from the proposal, the requirements and scenarios from the delta specifications by their headings, excerpted to fit, and the parsed tasks with their identifiers, descriptions, dependencies, scopes, and verification commands. It also computes the task-definition digest. Keeping it pure makes the excerpting, the cap, and the digest testable without a planning run. Requirement and scenario names are always kept, so questions can refer to them, and only the body text is excerpted.

### 3. Questions per task and one global

Each task gets five questions: whether its verification would fail if the task were implemented incorrectly, whether its write scopes cover every file its description requires changing, whether it is one coherent unit — where work that would naturally be two commits is a no — whether it depends on work not among its declared dependencies, and a four-level rubric of how large it is, from a single edit to too large to verify as one unit. One further question asks whether the tasks together cover every requirement. With the cap of forty tasks the request stays under about two hundred questions, well inside the service's limits.

Each question asks about a property of the text, not about the code the task will produce. The service is documented as weak at indirection, and "would this verification catch a wrong implementation" involves one hop; that is acceptable because the output is an advisory hint that a reviewer confirms.

### 4. Thresholds are symmetric and abstain when uncertain

A question whose good answer is yes yields a finding below 0.3, and one whose good answer is no yields a finding above 0.7. The size rubric yields a finding at 2.5 or above with confidence 0.7, and coverage below 0.3. Nothing in between produces a finding, so uncertainty costs nobody attention. The number of findings shown in the outcome is capped at eight, highest probability first, with the total stated, so a noisy list cannot bury the plan's own summary.

### 5. Findings are templates over structured answers

The gate's outcome is structured: a kind, a task identifier or none, and a probability. A pure function renders each as a fixed sentence naming the task and the probability. Judgment writes nothing, in keeping with what it is for.

### 6. Delivery without authority

The findings are delivered three ways and none of them is authoritative. They are stored on the decision record, bound to the task-definition digest. In enforce mode the planning outcome mentions them so the user sees them at once. And the review phase loads any record whose digest matches the current task definitions and passes its findings to the review controller as an optional input, which the review prompt renders as a short unverified-notes section. The reviewer decides what is real, and the review artifact is written only from the reviewer's output.

The original draft proposed feeding the findings directly into the review artifact as required changes. That would let a model-derived list author a correctness artifact and would blur which findings a reviewer had actually confirmed, so it is not done.

### 7. The definition digest ignores completion state

The digest hashes each task's identifier, description, dependencies, scopes, and verification commands, in identifier order, and excludes its checked state. It therefore changes when the plan changes and not when work is ticked off, which is exactly the binding needed at review time, when nothing is ticked, and at implementation time, when some tasks are.

### 8. Reconciliation at task outcome

When a task's pipeline finishes, the implementation phase finds the assessment record whose digest matches the current definitions and merges the task's outcome into its observations. A report groups tasks by finding kind and compares the non-completion rate for flagged and unflagged tasks. Only the first attempt's outcome is used, so a repair does not launder a defect.

### 9. The decision declares one effect

It adds advice. It grants nothing and skips nothing.

## Risks / Trade-offs

- **Noisy findings waste reviewer and user attention** → Symmetric thresholds that abstain when uncertain, a cap on displayed findings, an explicit unverified label, and correlation data before enforce is used.
- **A stale finding misleads a reviewer** → Findings are bound to the definition digest and dropped when it changes.
- **The assessment is weak at "would this verification catch a defect"** → Output is advisory and confirmed by a reviewer, and the correlation report shows whether that question earns its place.
- **Egress of the full task list** → Redaction, excerpting, and documentation; task lists describe intended work and rarely contain secrets, but the paths and commands are named in the documentation.
- **Coupling planning, review, and implementation** → Each connection is optional and additive, and a missing record simply means nothing is shown or reconciled.
- **Edits are in flight in the planning and review modules** → Implement on top of them.

## Migration Plan

1. Add the pure state builder with the definition digest, and register the decision with its templates.
2. Wire the assessment into the artifact-writing step and the planning outcome.
3. Pass current findings into the review controller and prompt.
4. Reconcile task outcomes at implementation and add the correlation report.
5. Add the documentation row and run the full validation set.

Rollout: shadow first; after enough changes have been implemented, read the correlation report; enable enforce only if flagged tasks fail materially more often than unflagged ones. Rollback: unset the enabling flag, or revert, which removes one call and two optional inputs.

## Open Questions

- Whether the fixed cap of forty tasks and eight displayed findings should be tuned once real task lists are seen. Affects only constants.
