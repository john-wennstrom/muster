## Context

The implementation phase compiles `tasks.md` into a DAG, selects the change worktree, creates or reads a run manifest, and runs the scheduler. For each task the `execute` callback either checkpoints a manual task or runs the pipeline: a fresh builder (primary slot, or the economy lane after a routing judgment on attempt one), a TDD check, the task's verify commands, a task review by a fresh reviewer at thinking `high` with an optional focus list from `review.task_focus`, evidence persistence and a checkbox tick. The scheduler gives each task two attempts, but only an attempt that throws is retried; a `blocked` outcome is final. Two thrown attempts become `debugging`.

The repair-progress policy (322 lines) and the debugging policy (186 lines) implement failure records and a progress assessment, and `debugging.thrash` is the Jev decision that assesses them; none is called by task execution.

Final validation's evidence gate requires, for every task, a completed persisted result and a matching approved review record. Verify re-runs every task's verify commands and then `bun test` at the worktree root.

## Goals / Non-Goals

**Goals:**

- Fewer sessions per change and cheaper sessions where the work is easy, without touching the deterministic gates.
- Failures teach the next attempt.
- The implementation phase is readable.

**Non-Goals:**

- Removing the reviewer or the builder. Skipping is per task, guarded, and never on the large lane.
- Changing the TDD policy, the verification commands' execution rules, the writer lease or the change worktree.
- Making the full-suite command configurable.
- Parallel writers.

## Decisions

### 1. Task merging is code, at plan time

`normalizePlan(plan)` runs after validation and before rendering. Task B merges into task A when B depends on exactly A, A has no other dependent, both are builder tasks with identical write scope sets (as sets of normalized paths) and neither is manual. The merged task keeps A's id, joins the descriptions in order ("Then: ..."), takes the union of reads, requirements, scenarios and verify commands (deduplicated, order kept), and B's dependents depend on A. It repeats until nothing merges. The outcome reports what merged (`merged 1.2 into 1.1: same write scope`), so the plan a user sees explains itself.

Rejected alternatives: merging at DAG compile time, which would make the task list on disk disagree with what runs; and a Jev decision to merge, which is unnecessary because the rule is exact and a false merge is worse than a missed one. The planning prompt also states the preference, so most plans arrive already merged.

### 2. Review skipping extends `review.task_focus`

The decision already asks seven questions about the finished task (security boundary, scope containment, contract match, scenario coverage, test-first consistency, stub or hard-coded, reach) and turns concerns into focus phrases. Skip is a second gate over the same answers: every question is confidently answered with its good value, so no focus item speaks and no answer is uncertain. Effects gain `reduces_work`. The version bumps to 2; question wording does not change.

Guards outside the answers, all required: the lane policy permits reduction (small and medium); mode is enforce; verification passed; the builder's TDD evidence was accepted; the diff excerpt is complete (not cut at the size limit) and every changed path is within the task's write scope; no changed path is denylisted; the task is not a retry (a task that already failed gets its review).

A skipped review writes a review record with verdict `APPROVE`, model `skipped`, `basis: "judgment"` and the decision record id. The review record schema gains an optional `basis` (`reviewer` by default). Final validation's evidence gate accepts a `judgment` basis only when the run manifest's lane permits reduction and the record names a judgment record id; otherwise the gate fails naming the task. A reviewer approval is unaffected. An honest label matters more than the saved session: the record says nothing read the diff.

### 3. Thinking per task from `routing.task_model` v2

The routing decision already answers mechanical, deep-reasoning, large-context, novel-design, security-boundary, public-contract and reach questions before the first attempt. Version 2 adds an output to its gate: a builder thinking level and a reviewer thinking level. Mechanical and narrow with every risk confidently absent gives `low` for the builder and `medium` for the reviewer; mechanical with a moderate reach gives `medium` and `high`; anything else, any uncertainty, retries and the large lane keep the configured builder thinking and `high` for the reviewer. Thinking is never lowered by more than the table says and never below `low`.

The economy model pattern extends to review: `MUSTER_REVIEWER_ECONOMY_MODEL`, independent and optional, names a model used for the reviewer of a task whose routing verdict is economy-eligible. As with the builder lane, the harness never chooses a model the user did not configure. The economy lane no longer inherits the primary builder's thinking; thinking is chosen per task by the decision, and prompts and tools are still inherited. One call per task serves both roles; the verdict is carried to the review step.

### 4. Failures are recorded, and a decision chooses what happens next

`src/execution/recovery.ts` writes `failures/<task>.json` after any attempt that does not complete: the attempt number, the outcome, evidence excerpts (at most 2,000 bytes each), the reproduction (the verify command and its exit code and output tail, at most 1,000 bytes), the builder's stated fix, and the changed paths. At most the two latest are kept. The builder prompt gets the latest failure as an optional block, so both an in-run retry and a later `/change implement` start informed. This is free and needs no judgment.

`task.recovery` (replacing `debugging.thrash`, wording adapted) is asked after a failed attempt when the state has enough to judge, and returns one of: `retry` (the failure is a fixable defect in the attempt), `escalate` (the failure shows the change is broader or harder than its lane, so promote it), or `stop` (the failure needs a person: an environment problem, a missing credential, an ambiguous requirement). Effects: `adds_caution` for escalate and stop, and retry is the only outcome that adds an attempt, bounded by the scheduler's existing limit of two attempts, so the decision never lengthens the loop beyond what the scheduler already permitted.

- Without judgment, unavailable or uncertain: today's behavior. A thrown attempt is retried; a blocked outcome is final.
- `retry` on a blocked outcome caused by failed verification or a reviewer's required repairs: the attempt returns `failed` to the scheduler, which retries once with the primary configuration and the failure in the prompt.
- `escalate`: `escalateLane`, the task stays ready, the command ends blocked with next `/change review`, because escalation makes the review stale.
- `stop`: the command ends blocked with the reason and the failure record path, and the task is not retried.

### 5. Verification reuse

At verify, a task's commands are skipped when its persisted task result names each command with exit 0 and its recorded source digest equals the current source digest. Since later tasks change the source, this holds for the last unit and for single-unit changes, which is where merging leaves small changes. The full-suite run always happens. The verification evidence marks reused commands as reused.

### 6. Decomposing the implementation phase

`src/execution/run-manifest.ts` owns creating, reading, validating and persisting the manifest (including the lane). `src/execution/unit-runner.ts` owns one task's execute callback: manual checkpoint, routing, builder, TDD, verification, review or skip, evidence persistence, failure recording and recovery. `phases/implementation.ts` keeps argument handling, worktree selection, DAG compilation, the scheduler call and result mapping. The existing step modules under `task-steps/` are kept.

## Risks / Trade-offs

- **A skipped review misses a defect the reviewer would have caught** -> Skipping needs every answer confidently good plus test-first evidence, passing verification, a complete diff within scope, an enforce-mode small or medium lane, and a first attempt. The record is labelled, and shadow mode measures how often the reviewer's findings would have been missed before enforce is trusted.
- **Merging hides a legitimate boundary** -> Only exact same-scope chains merge, and the outcome lists every merge.
- **`retry` adds LLM cost** -> Only one extra attempt, only with judgment enforcing, only for a blocked task with recorded findings, and the alternative is the user re-running the command by hand with less context.
- **Escalation mid-run surprises the user** -> It ends the command cleanly with the reason and the next command; no work is discarded.
- **Two thinking levels lower answer quality for a misjudged task** -> Only mechanical, narrow tasks with all risks confidently absent get lower thinking, retries return to configured thinking, and routing records are reconciled with outcomes.

## Migration Plan

Refactor first with no behavior change (split the phase), then add failure records and the recovery decision, then routing v2 and skipping, then verification reuse, then documentation. Runs recorded before this change are not resumed across it. Rollback is a revert.
