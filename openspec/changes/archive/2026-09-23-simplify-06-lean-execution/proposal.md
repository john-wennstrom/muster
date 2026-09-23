## Why

Implementation is where a change spends most of its tokens, and it spends them per task.

- Every task gets a fresh builder session and a fresh reviewer session at fixed high thinking. A plan whose task 1.2 depends on 1.1 and writes the same files pays two builders and two reviewers, and the second builder re-reads what the first just wrote.
- The task reviewer always runs, whatever the change looks like. A mechanical one-file edit with test-first evidence and a passing focused test costs the same review as a design-heavy change.
- Builder thinking comes from the slot and reviewer thinking is fixed at high, for every task. Routing already asks whether a task is mechanical and narrow, but only to pick a cheaper model, never a cheaper thinking level.
- A failed task leaves no memory. A blocked outcome is final for the run, and re-running `/change implement` starts a fresh builder with no knowledge of why the last one failed. The repair-progress policy and the thrash decision that were meant to shorten this loop are built but not connected to task execution.
- `/change verify` re-runs every task's verification commands even when nothing has changed since they passed.
- `implementation.ts` is 452 lines mixing worktree selection, manifest handling, checkpoint handling, per-task execution, outcome bookkeeping and result mapping.

## What Changes

- Merge chained tasks with identical write scopes into one, in code, after plan validation, and tell the planner to prefer one task per cohesive file set.
- Let the existing `review.task_focus` decision also decide that a task review can be skipped, only when every guard holds and the lane permits reduction. A skipped review is recorded as skipped and names its judgment record, and final validation accepts it only under those conditions. **BREAKING** relative to the rule that judgment never changes a review gate.
- Extend `routing.task_model` (version 2) to choose the builder's and reviewer's thinking level per task and to allow an optional economy reviewer model, keeping retries on the primary configuration.
- Record every task failure with bounded evidence, include the latest failure in the next builder prompt, and replace the unwired thrash decision and repair-progress policy with one `task.recovery` decision that chooses retry, escalate or stop after a failed attempt.
- Reuse a task's recorded verification evidence at verify when the source has not changed since it passed; the full suite always runs.
- Split the implementation phase into a thin orchestrator, a run manifest module and a per-task unit runner.
- Record the lane in the run manifest and make final validation lane-aware for skipped reviews.

## Capabilities

### New Capabilities

- `task-merging`: when and how chained tasks merge, and what a merge preserves.
- `review-skipping`: when a task review may be skipped, how it is recorded, and how final validation treats it.
- `task-recovery`: failure records, failure context in the next attempt, and the retry, escalate and stop decision.
- `implementation-layout`: the thin phase and the modules it delegates to.
- `verification-reuse`: reuse of current task evidence at verify.

### Modified Capabilities

- `judgment-model-routing`: thinking levels per task, an optional reviewer economy model, and thinking no longer inherited from the primary builder.
- `judgment-task-review-focus`: a review may be skipped under guards, replacing the rule that judgment never changes a review gate.
- `judgment-thrash-detection`: removed and replaced by `task-recovery`.

## Impact

- **New:** `src/planning/normalize.ts`, `src/execution/recovery.ts`, `src/execution/run-manifest.ts`, `src/execution/unit-runner.ts`, `src/judgment/decisions/task-recovery.ts`, `prompts/judgment/task.recovery.yaml`, failure records under the change's run store.
- **Removed:** `src/policies/debugging.ts`, `src/policies/repair-progress.ts`, the `debugging.thrash` decision and their tests.
- **Changed:** the builder and review steps, the review record schema (a `basis` field), the run manifest (a `lane` field), the final validator's evidence gate, the verification phase, and `phases/implementation.ts`.
- **Behavior:** with judgment disabled or unavailable, task execution is as before except that merged tasks run as one, failures are recorded and the latest one appears in the next builder prompt, and verify reuses current evidence. Skipping, thinking levels and automatic retry need judgment in enforce mode and a lane that permits reduction.
- **Persisted records:** review records gain `basis`, manifests gain `lane`, and failure records are new. Older runs are not migrated.
- **Prerequisite:** simplify-05-structured-planning, for the plan normalization hook, lane escalation into review, and the decisions layout.
