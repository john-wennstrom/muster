## 1. Merge chained tasks

- [x] 1.1 Create `src/planning/normalize.ts` exporting `normalizePlan(plan)` returning the merged plan and a list of merge notes. A task B merges into task A when B depends on exactly A, A has no other dependent, both are builder tasks, neither has a manual block, and their write scopes are equal as sets of normalized paths. A merged task keeps A's id, joins the descriptions ("Then: ..."), takes the deduplicated union of reads, requirement references, scenario references and verify commands in first-seen order, and every task that depended on B depends on A. Repeat until nothing merges. Call it from the planning orchestration after validation and before rendering, and add each note ("merged 1.2 into 1.1: same write scope") to the planning outcome summary. Add a sentence to `prompts/agents/planning-plan.md` telling the session to prefer one task per cohesive set of files and to split only when parallelism or independent verification is real, and update its golden. Add tests for a same-scope chain, a chain of three, different scopes, a manual task, a fan-out, and dependents being rewired.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/planning/**", "prompts/**", "tests/**"]
  writes: ["src/planning/normalize.ts", "src/planning/run.ts", "prompts/agents/planning-plan.md", "tests/planning/**", "tests/prompts/golden/agents/**"]
  requirements: ["task-merging: Chained tasks with the same write scope are merged", "task-merging: Merging preserves coverage", "task-merging: Merges are reported", "task-merging: The planner is told to prefer cohesive tasks"]
  scenarios: ["A same-scope chain merges", "Different scopes do not merge", "A manual task is never merged", "A fan-out is not merged", "References and commands are unioned", "Dependents are rewired", "The outcome lists a merge", "The instruction is present"]
  verify: ["bun test tests/planning", "bun test tests/prompts", "bun run typecheck"]
  manual: null
  ```

## 2. Split the implementation phase

- [x] 2.1 Refactor `src/change/phases/implementation.ts` with no behavior change. Create `src/execution/run-manifest.ts` owning creation, reading, identity checking and persistence of the run manifest, and add an optional `lane` field to the manifest record schema, written from `readLane` at creation and refreshed on read. Create `src/execution/unit-runner.ts` exporting the per-task execute callback: manual checkpointing, routing and builder selection, TDD check, verification, review, evidence persistence, checkbox synchronization and first-attempt reconciliation. Leave in the phase only argument handling, worktree selection, task graph compilation, recovery-plan construction, the scheduler call and result mapping. Keep the existing step modules. Move or split tests so each new module has direct tests, and confirm the existing implementation tests pass unchanged. No module may exceed about 250 lines.

  ```yaml harness-task
  id: "2.1"
  dependsOn: []
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/change/phases/implementation.ts", "src/execution/run-manifest.ts", "src/execution/unit-runner.ts", "src/persistence/records.ts", "tests/execution/**", "tests/muster/**", "tests/persistence/**", "tests/e2e/**"]
  requirements: ["implementation-layout: The implementation phase is a thin orchestrator", "implementation-layout: The run manifest has one owner", "implementation-layout: Decomposition preserves behavior", "review-skipping: The run manifest records the lane"]
  scenarios: ["The phase file delegates", "One writer of the manifest", "The same run produces the same records", "Manifest carries the lane"]
  verify: ["bun test tests/execution", "bun test tests/muster", "bun test tests/persistence", "bun test tests/e2e", "bun run typecheck"]
  manual: null
  ```

## 3. Failures teach the next attempt

- [x] 3.1 Create `src/execution/recovery.ts` with `recordFailure(store, change, task, failure)` writing `failures/<task>.json` (attempt number, outcome, evidence excerpts of at most 2,000 bytes each, reproduction with the failing command, exit code and an output tail of at most 1,000 bytes, the builder's stated fix, changed paths; redacted with the existing telemetry redaction; keeping the two latest) and `latestFailure(store, change, task)`. Create the `task.recovery` decision in `src/judgment/decisions/task-recovery.ts` with `prompts/judgment/task.recovery.yaml`, adapting the wording and state builder of `debugging.thrash`: after one failed attempt, choose `retry`, `escalate` or `stop`, acting only on confident answers, with effects `adds_caution` and the retry answer bounded by the caller. Delete `src/policies/debugging.ts`, `src/policies/repair-progress.ts`, the `debugging.thrash` decision module, question file, golden and tests, and update the catalog, the source-hygiene allowlist and the prompt exclusion list. Add tests for recording, pruning, redaction, and each verdict with the scripted client.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "prompts/**", "tests/**"]
  writes: ["src/execution/recovery.ts", "src/judgment/decisions/**", "src/judgment/catalog.ts", "src/policies/**", "prompts/judgment/**", "tests/execution/**", "tests/judgment/**", "tests/policies/**", "tests/prompts/**", "tests/layering/**"]
  requirements: ["task-recovery: Every failed attempt is recorded", "task-recovery: A decision chooses retry, escalate or stop", "task-recovery: The unconnected repair policies are removed"]
  scenarios: ["A verification failure is recorded", "Only the latest two are kept", "The modules are gone", "Retry within the limit"]
  verify: ["bun test tests/execution", "bun test tests/judgment", "bun test tests/prompts", "bun test tests/layering", "bun run typecheck"]
  manual: null
  ```

- [x] 3.2 Wire recovery into the unit runner. The builder prompt template gains an optional `PRIOR_FAILURE` block filled from `latestFailure` (empty when none), with the golden updated. After an attempt ends without completing, record the failure, then ask `task.recovery` through `tryJudge` once. In enforce mode with a confident verdict: `retry` on a blocked outcome caused by failed verification or required reviewer repairs returns a `failed` result to the scheduler so it retries once with the primary configuration (the scheduler's limit of two attempts is never exceeded); `escalate` calls `escalateLane`, refreshes the manifest lane, leaves the task ready and ends the command blocked with next `/change review`; `stop` ends the command blocked with the reason and the failure record path. With judgment disabled, unavailable, uncertain or in shadow mode, behavior is unchanged (a thrown attempt retries, a blocked outcome is final) and shadow reconciles the record with what would have happened. Add tests for each verdict, the limit, shadow, unavailable, and the prompt block on a later invocation.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/**", "prompts/**", "tests/**"]
  writes: ["src/execution/unit-runner.ts", "src/execution/recovery.ts", "src/change/phases/implementation.ts", "src/change/phases/task-steps/**", "prompts/agents/**", "tests/execution/**", "tests/muster/**", "tests/prompts/golden/agents/**"]
  requirements: ["task-recovery: The next attempt starts informed", "task-recovery: A decision chooses retry, escalate or stop", "task-recovery: Without judgment behavior is as before"]
  scenarios: ["A retry sees the failure", "A first attempt has no block", "Retry within the limit", "Retry never exceeds the limit", "Escalate promotes the lane", "Stop ends the run for the task", "Unavailable judgment", "Shadow records the alternative"]
  verify: ["bun test tests/execution", "bun test tests/muster", "bun test tests/prompts", "bun run typecheck"]
  manual: null
  ```

## 4. Cheaper tasks

- [x] 4.1 Bump `routing.task_model` to version 2 in `src/judgment/decisions/routing-task-model.ts`: its gate additionally returns builder and reviewer thinking levels per the rules (mechanical, all risks confidently absent and confidently narrow: builder low and reviewer medium; mechanical with moderate reach: builder medium and reviewer high; anything else, any uncertainty, any retry and the large lane: configured builder thinking and reviewer high; never below low), applying nothing when the lane policy does not permit reduction. Add `MUSTER_REVIEWER_ECONOMY_MODEL` resolution beside the builder economy model in `src/change/models.ts`, both optional and independent, with the lane inheriting prompts and tools but not the primary's thinking. Make the builder step pass the chosen thinking to the spawn entry point, carry the verdict to the review step in the task step context so exactly one routing request is made per task, and make the review step use the chosen reviewer thinking and the reviewer economy model when the verdict is economy-eligible. Add tests for each thinking outcome, one request per task, retries keeping configured thinking, and the large lane.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/judgment/decisions/routing-task-model.ts", "src/change/models.ts", "src/change/phases/task-steps/**", "src/execution/unit-runner.ts", "tests/judgment/**", "tests/muster/**", "tests/execution/**"]
  requirements: ["judgment-model-routing: Economy models are explicit configuration", "judgment-model-routing: Thinking is chosen per task", "judgment-model-routing: One routing request serves builder and reviewer"]
  scenarios: ["Each override resolves independently", "Economy lane inherits prompts and tools", "Absent override yields no lane", "A mechanical narrow task", "An uncertain task keeps configured thinking", "A retry keeps configured thinking", "The large lane never lowers thinking", "One request per task"]
  verify: ["bun test tests/judgment", "bun test tests/muster", "bun test tests/execution", "bun run typecheck"]
  manual: null
  ```

- [x] 4.2 Extend `review.task_focus` to version 2 in `src/judgment/decisions/review-task-focus.ts` with a skip gate over its existing answers: skip only when every question is answered confidently with its good value. Add optional `basis` (`reviewer` by default or `judgment`) and an optional judgment record identifier to the task review record schema in `src/persistence/records.ts`. In the review step, skip the reviewer only when every guard in the spec holds (enforce mode; lane policy permits reduction; verification passed; TDD evidence accepted; complete diff excerpt with every changed path in the write scope and none denylisted; first attempt), writing a review record with verdict APPROVE, model `skipped`, basis `judgment` and the decision record id; in shadow mode run the reviewer and record that it would have been skipped. Update the evidence gate in `src/review/validator.ts` to accept a judgment-basis record only when the run manifest lane permits reduction and the record names a decision record. Add tests for each guard failing, shadow, unavailable, the large lane, and the three evidence gate scenarios.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1", "2.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/judgment/decisions/review-task-focus.ts", "src/persistence/records.ts", "src/change/phases/task-steps/review.ts", "src/review/validator.ts", "src/execution/unit-runner.ts", "tests/judgment/**", "tests/muster/**", "tests/review/**", "tests/persistence/**"]
  requirements: ["review-skipping: A task review is skipped only when every guard holds", "review-skipping: The large lane never skips a review", "review-skipping: Shadow mode and unavailable judgment never skip", "review-skipping: A skipped review is recorded as skipped", "review-skipping: Final validation accepts a skipped review only under the lane's permission"]
  scenarios: ["Every guard holds", "One answer is uncertain", "A changed path is outside scope", "A retry is always reviewed", "Large lane", "Shadow records the would-have-skipped", "Unavailable judgment", "The record is labelled", "A reviewer approval is unchanged", "A permitted skip", "A skip on the large lane", "A skip without a decision record"]
  verify: ["bun test tests/judgment", "bun test tests/muster", "bun test tests/review", "bun test tests/persistence", "bun run typecheck"]
  manual: null
  ```

## 5. Verification reuse

- [x] 5.1 In the verification phase, skip a task's verify commands when its persisted task result lists each command with exit 0 and its recorded source digest equals the current source digest; run every other command; always run the full suite. Mark reused commands as reused, with the digest, in the verification artifact and its parser. Add tests for unchanged source, changed source, a partially matching command list, and the full suite still running.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/change/phases/verification.ts", "src/review/verification-artifact.ts", "tests/muster/**", "tests/review/**"]
  requirements: ["verification-reuse: Current task evidence is reused", "verification-reuse: Reused evidence is labelled"]
  scenarios: ["Unchanged source reuses evidence", "Changed source reruns", "The artifact marks reuse"]
  verify: ["bun test tests/muster", "bun test tests/review", "bun run typecheck"]
  manual: null
  ```

## 6. Documentation

- [x] 6.1 Update `docs/security.md`: replace the `debugging.thrash` row with a `task.recovery` row (sent after a failed attempt: the task definition, the latest failure evidence and reproduction with the stated byte bounds, and the stated fix; redacted; it can end a task, escalate the lane or add one attempt), update the `review.task_focus` row to say its answer can skip a review under the listed guards, and update the `routing.task_model` row to mention thinking levels and the reviewer economy model. Update the README's model configuration section for `MUSTER_REVIEWER_ECONOMY_MODEL`, thinking per task and skipped reviews. Run `bun run docs:check`.

  ```yaml harness-task
  id: "6.1"
  dependsOn: ["3.2", "4.2", "5.1"]
  role: builder
  reads: ["docs/**", "README.md"]
  writes: ["docs/security.md", "README.md"]
  requirements: ["task-recovery: Recovery egress is documented"]
  scenarios: ["One row replaces one"]
  verify: ["bun run docs:check"]
  manual: null
  ```
