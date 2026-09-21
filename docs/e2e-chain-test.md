# End-to-end chain test: reading-time helper in minding

A small, real job for running every `/change` command once against a real repository, the sibling `minding` checkout, on two lanes. Both jobs add pure TypeScript helpers and their tests to minding's console. The first is a single function that takes the **small** lane, and the second is a two-file job that takes the **medium** lane and has two dependent tasks, so it exercises the task DAG, the writer lease, the change worktree, task review, final verification and archiving. The flow of each command is drawn in [command-flow.md](command-flow.md), and the numbers this run should produce for the [simplification record](simplification.md#measured-figures) are the sessions, input and output tokens, and cost of each job.

Nothing in this document has been run. The steps and expected results come from reading the code, and each step says what to check so a mismatch is easy to spot. Rerunning is cheap: each job uses its own change name, so the run stores do not collide, and [Cleaning up](#cleaning-up) removes everything a job leaves behind.

## Why this job

Three things about how Muster verifies work shaped the choice:

- **Verification commands cannot run `cargo`.** The `verification` command profile allows only `bun`, `node`, `npm`, `npx`, `git` and `openspec` ([command-profile.ts](../src/tools/command-profile.ts)). A Rust job in minding could be built but never verified. The console is TypeScript with `bun test`, so the job lives there.
- **`/change verify` always appends a full `bun test` at the worktree root.** In minding that runs every test under `console/`. A fresh worktree has no `node_modules`, so that run fails with about 20 "Cannot find package" errors until you install the console's dependencies inside the worktree. The runbook has that step.
- **The console's `src/lib/domain/` layer is pure TypeScript.** `console/CLAUDE.md` in minding forbids React, fetch and server types there, so the tests need no dependencies and the job cannot break anything else.

The second job has two files with **disjoint write scopes** on purpose. Tasks that form a `dependsOn` chain and write the same files are merged into one task when the plan is normalized, so a plan whose two tasks shared a scope would come out as one task and the DAG would have no dependency to exercise.

The jobs are also disjoint from any uncommitted work in minding's `console/`. The change worktree starts from `HEAD`, so that work is not in it.

## The jobs

### Job A: one function, small lane

Add `console/src/lib/domain/readingTime.ts` and `console/src/lib/domain/readingTime.test.ts`:

| Function | Behavior |
| --- | --- |
| `estimateReadingTime(wordCount, wordsPerMinute = 238)` | Whole minutes, rounded up. `0` for 0 words, at least `1` for any positive count. `RangeError` for a negative, `NaN` or infinite word count, or a words-per-minute that is not a positive finite number. |

One task, verified by one command that runs from the repository root: `bun test console/src/lib/domain/readingTime.test.ts`.

### Job B: two files with a dependency, medium lane

Add `console/src/lib/domain/readingTime.ts` (with `estimateReadingTime` as above and `formatReadingTime`), its test file, and then `console/src/lib/domain/readingTimeLabel.ts` with its own test file:

| Function | Behavior |
| --- | --- |
| `formatReadingTime(minutes)` | `0` gives `No reading time`. `1` to `59` gives `N min read`. `60` or more gives `H h M min read`, or `H h read` when the remainder is 0. `RangeError` for a negative, fractional or non-finite input. |
| `readingTimeLabel(wordCount, wordsPerMinute?)` | `formatReadingTime(estimateReadingTime(wordCount, wordsPerMinute))`. |

Two tasks. Task `1.1` writes `readingTime.ts` and `readingTime.test.ts`. Task `1.2` writes `readingTimeLabel.ts` and `readingTimeLabel.test.ts`, depends on `1.1`, and imports its functions. Each task is verified by one command: `bun test console/src/lib/domain/readingTime.test.ts` and `bun test console/src/lib/domain/readingTimeLabel.test.ts`.

## Before you start

1. Tools on `PATH`: `pi`, `openspec`, `bun` 1.4.
2. Model credentials for the roles you use. Muster resolves each role from `MUSTER_ARCHITECT_MODEL`, `MUSTER_BUILDER_MODEL`, `MUSTER_REVIEWER_MODEL` and `MUSTER_VALIDATOR_MODEL`, then from `--fh-config`, then from `--architect` and `--builder`, then from a declared fallback ([models.ts](../src/change/models.ts)). minding already has a stack at `.pi/fusion-harness/model-stack-fusion.yaml`.
3. A launch that loads Muster from this repository while working in minding:

```bash
cd ../minding
pi -e <path-to-muster>/src/muster/index.ts --fh-config .pi/fusion-harness/model-stack-fusion.yaml
```

If Pi registers the commands twice because a global Pi setting also loads a copy of Muster, add `-ne` so only the explicit `-e` extension loads. This launch line is untested.

4. Note minding's current `git status`. The jobs leave minding's working tree alone until `finish`, when OpenSpec writes into `openspec/`.
5. Judgment is off unless you set it (see [Variant A](#variant-a-with-judgment-on)). The base runs below assume it is off, so the lane is the one you choose with `lane=` or the pattern floor, and every review is a reviewer's.

## Job A runbook: the small lane

Paste the propose line, then run the rest in order in the Pi session started above. The propose line names the lane with `lane=small`, which overrides triage and sends no judgment request. Without judgment, a change can reach the small lane in no other way.

```text
/change propose minding-reading-time lane=small Add a pure estimateReadingTime(wordCount: number, wordsPerMinute = 238): number to console/src/lib/domain/readingTime.ts with tests in console/src/lib/domain/readingTime.test.ts. It returns whole minutes rounded up, 0 for 0 words, at least 1 for any positive count, and throws RangeError for a negative, NaN or infinite word count or a words-per-minute that is not a positive finite number. Plan one task that writes both files, verified by bun test console/src/lib/domain/readingTime.test.ts.
```

| # | Command | Expect | Check |
| --- | --- | --- | --- |
| 1 | `/change explore Where do pure formatting helpers live in console/src/lib/domain, what do their tests look like, and is there already a reading-time or word-count helper?` | A success panel with a read-only answer. No lifecycle, no change. | `openspec list` shows no new change and `git status` is unchanged. |
| 2 | `/change status minding-reading-time` | Refused or failed, naming a change that does not exist. | Nothing was created. This is the "unknown change" guard. |
| 3 | The `/change propose` line above | Success on the small lane, next `/change review minding-reading-time`. **One plan session**, no preflight, no opinions, no debate. | `openspec/changes/minding-reading-time/` holds `proposal.md`, `design.md`, `specs/*/spec.md` and `tasks.md`, all rendered by code. `tasks.md` has **one** task with a `yaml harness-task` block. `/change status` shows `Lane: small`. |
| 4 | `/change implement minding-reading-time` | Blocked: no current approved `review.md`. Next `/change review minding-reading-time`. | The lifecycle gate refuses before any worktree is created. |
| 5 | `/change review minding-reading-time` | Success, `Plan approved by lint`, next `/change implement`. **No reviewer session.** Without judgment the semantic check did not run, and the outcome says so. | `review.md` has `Mode: lint`, model `lint`, the list of checks that ran, and `semanticCheck` `unavailable`. |
| 6 | `/change status minding-reading-time` | `Lifecycle: READY`, `Lane: small`, `Review: current`, `Validation: missing`, `Pending checkpoints: 0`, and usage totals for planning. | |
| 7 | `/change implement minding-reading-time` | A change worktree is created, task `1.1` runs and completes. Success, next `/change verify`. **One builder session and one task reviewer session** (judgment is off, so nothing skips the review). | See below. |
| 8 | Install the console's dependencies in the worktree (below). | | |
| 9 | `/change verify minding-reading-time` | `Final verification PASS`, next `/change finish`. | `verification.md` and `validation.json` exist. The task's verify command is marked `reused` with the source digest, because its passing result was recorded against the same source and installing ignored dependencies does not change it; the full `bun test` ran. `/change status` shows `Lifecycle: VERIFIED`. |
| 10 | `/change finish minding-reading-time` | `Archived minding-reading-time as ...`. | `openspec/changes/archive/` has the archived change. |

Expected sessions for Job A, without judgment: plan 1, planning reviewer 0, builder 1, task reviewer 1, **3 in all**. With judgment in enforce mode and every focus answer good, the task reviewer is skipped too and the job costs **2**. The session budget test in [tests/e2e/session-budget.test.ts](../tests/e2e/session-budget.test.ts) holds the small lane to at most three.

Escalation is worth trying once. Add a second task to the plan by refining it (`/change refine minding-reading-time Also add a formatReadingTime function and a third task`) and review again: a small plan over the lane's limits (two tasks, no manual tasks) escalates the change to `medium`, a reviewer runs, and `/change status` then shows `Lane: medium`.

## Job B runbook: the medium lane

The propose line names `lane=medium`, which is also what the pattern floor gives a change this size.

```text
/change propose minding-reading-time-label lane=medium Add pure reading-time helpers to the console domain layer. Task 1.1 creates console/src/lib/domain/readingTime.ts and console/src/lib/domain/readingTime.test.ts with estimateReadingTime(wordCount: number, wordsPerMinute = 238): number (whole minutes rounded up, 0 for 0 words, at least 1 for any positive count, RangeError for a negative, NaN or infinite word count or a non-positive or non-finite words-per-minute) and formatReadingTime(minutes: number): string (0 gives "No reading time", 1 to 59 gives "N min read", 60 or more gives "H h M min read" or "H h read" when the remainder is 0, RangeError for a negative, fractional or non-finite input). Task 1.2 depends on 1.1 and creates console/src/lib/domain/readingTimeLabel.ts and console/src/lib/domain/readingTimeLabel.test.ts with readingTimeLabel(wordCount: number, wordsPerMinute?: number): string, which is formatReadingTime(estimateReadingTime(wordCount, wordsPerMinute)). Each task is verified by bun test on its own test file. The two tasks write different files.
```

| # | Command | Expect | Check |
| --- | --- | --- | --- |
| 1 | The `/change propose` line above | Success on the medium lane, next `/change review`. One plan session, no opinions, no debate. | `tasks.md` has **two** tasks, `1.2` depends on `1.1`, and their write scopes differ. The outcome lists no merge note. If it lists one, the plan gave both tasks the same scope: refine it so the scopes differ. |
| 2 | `/change implement minding-reading-time-label` | Blocked: no current approved `review.md`. | The lifecycle gate. |
| 3 | `/change refine minding-reading-time-label Also require tests that estimateReadingTime(1) is 1, that wordsPerMinute = 1 works, and that formatReadingTime(60) is "1 h read".` | Success, next `/change review`. | The requested cases appear in `specs/*/spec.md` and `tasks.md`. |
| 4 | `/change review minding-reading-time-label` | `APPROVE`, next `/change implement`. **One planning reviewer session.** On `REVISE`, run `/change refine minding-reading-time-label` with no text (it folds the required changes in by itself) and review again. | `review.md` has `Mode: reviewer`, a `round`, the reviewer's model and an artifact digest. A model other than the author's is preferred, but minding's stack puts every slot on one model, so the reviewer is that model in a fresh session. |
| 5 | `/change status minding-reading-time-label` | `Lifecycle: READY`, `Lane: medium`, `Review: current`. | |
| 6 | `/change implement minding-reading-time-label` | A change worktree is created, task `1.1` runs and completes, then `1.2`. Success, next `/change verify`. **Two builder sessions and two task reviewer sessions.** | See below. |
| 7 | Install the console's dependencies in the worktree (below). | | |
| 8 | `/change verify minding-reading-time-label` | `Final verification PASS`, next `/change finish`. | Task `1.2`'s command may be marked `reused` in `verification.md`, since its result was recorded against the final source; `1.1`'s is rerun, because `1.2` changed the source after it. The full `bun test` always runs. |
| 9 | `/change finish minding-reading-time-label` | `Archived ... as ...`. | `openspec/changes/archive/` has the archived change. |

Expected sessions for Job B, without judgment: plan 1, planning reviewer 1, builders 2, task reviewers 2, **6 in all**. The session budget test holds a one-task medium change to at most four.

After the implement step of either job, check:

- The worktree is `../.muster-worktrees/minding/<change>` on branch `muster/<change>`, created from minding's `HEAD`. `git -C` that path shows the new files under `console/src/lib/domain/`.
- Every checkbox in the change's `tasks.md` is ticked, in the planning checkout, not the worktree.
- Under minding's `.fusion/runs/run-<change>/` there are `manifest.json` (with the change's `lane`), `task-results/`, `reviews/`, `tdd/`, `reports/`, `usage/` and, after any failed attempt, `failures/`. Each task has a TDD record showing the tests failed before the implementation.
- In Job B, `1.2` did not start before `1.1` finished.

For the dependency install step, before `/change verify`:

```bash
cd ../.muster-worktrees/minding/<change>/console && bun install --frozen-lockfile
```

`node_modules` is ignored by Git, so this does not change the worktree's source digest and does not make verification stale.

## What each command should have proved

| Command | Proved by |
| --- | --- |
| `explore` | Job A step 1: a read-only agent ran, and no change or lifecycle came into being. |
| `propose` | Both jobs: the change exists with valid, strictly validated artifacts rendered from a typed plan, on the lane you named, with a parseable task DAG. |
| `refine` | Job B step 3: the artifacts changed and the next step is review. |
| `review` | Job A step 5 (lint approval, no reviewer) and Job B step 4 (a fresh reviewer wrote a verdict bound to the artifact digest). |
| `implement` | The worktree, the writer lease, the fresh builder per task, the TDD evidence, the focused verification, the task review, and the ticked checkboxes. |
| `verify` | All nine final-validation gates passed, including the full `bun test`. |
| `finish` | The archive, and the digest freshness check before it. |
| `status` | Job A steps 2 and 6, and again after each later step, including the `Lane:` line. |
| lifecycle gates | Job A steps 2 and 4: a command refused with a specific reason and the exact next command. |

`resume` is not reached by these paths. See variant B.

## Variant A: with judgment on

Run either job a second time under a new change name, for example `minding-reading-time-jev`, so the two runs do not share a run store. Set these in the shell before launching Pi:

```bash
export MUSTER_JEV=1
export MUSTER_JEV_API_KEY=<your key>
export MUSTER_JEV_MODE=shadow
```

Judgment sends repository content to a third-party classifier. Read [the judgment egress section of the security model](security.md#judgment-egress) first, and confirm that minding's code may leave the machine.

Once `MUSTER_JEV=1` and a key are set, judgment **enforces by default**. `MUSTER_JEV_MODE=shadow` is what selects shadow, so the first pass above evaluates and records every call and changes no behavior, and the outcome should match the base run. The decision records are under `.fusion/runs/run-<change>/judgment/`. Expect records for:

| Decision | From |
| --- | --- |
| `change.triage` | propose, unless `lane=` is given: drop `lane=` from the prompt to see the lane triage would choose. In shadow mode the lane is the pattern lane and the record notes the lane enforce mode would have chosen. |
| `plan.lint` | review, on a task list of at most 40 tasks, after deterministic lint passes |
| `review.triage` | a second `/change review` after a prose-only edit to `proposal.md` or `design.md`, once a reviewer approved |
| `routing.task_model` | each task's first attempt during implement, on the small and medium lanes |
| `command.classification` | each brokered host command during implement |
| `review.task_focus` | each task's review during implement |
| `task.recovery` | only after a failed attempt |

`review.extraction` fires only when a reviewer returns unstructured output, so it is not expected. The variables `MUSTER_JEV_REVIEW_TRIAGE` and `MUSTER_JEV_MODEL_ROUTING` were removed and are not read: no decision has its own flag, and routing needs no economy model, because it also chooses the thinking level per task. `MUSTER_BUILDER_ECONOMY_MODEL` and `MUSTER_REVIEWER_ECONOMY_MODEL` are optional and independent; set them only if you want a cheaper model for eligible tasks.

Then repeat without `MUSTER_JEV_MODE` (or with `MUSTER_JEV_MODE=enforce`) and compare. In enforce mode triage may choose the small lane for Job A without `lane=`, a small plan is approved by lint plus the semantic check, a task whose every focus answer is good has its review skipped and recorded as skipped (so Job A costs two sessions), and a prose-only edit after an approved review may be carried forward without a reviewer. Compare the session counts with the expected figures above and record them, with the token and cost totals from `/change status`, in [Measured figures](simplification.md#measured-figures).

## Variant B: a manual checkpoint and `resume`

Use Job B, because a manual task is not allowed on the small lane. To reach `AWAITING_USER`, add this sentence to the end of the propose prompt: "Add a third task 1.3 that depends on 1.2, has role manual, and carries a manual block with category design_decision that asks the owner to confirm the label wording."

Then run the same steps. Expected:

1. `/change implement` completes `1.1` and `1.2`, then stops. The outcome is blocked with a pending checkpoint, `/change status` shows `Lifecycle: AWAITING_USER` and lists the checkpoint id, and the checkpoint instructions contain no secrets.
2. `/change implement minding-reading-time-label` is now refused with the pending checkpoint id, because only `resume` is allowed.
3. `/change resume minding-reading-time-label <checkpoint-id>` records who confirmed the checkpoint and runs the flow again. Task `1.3` completes from the confirmation instead of pausing a second time: its checkbox is ticked, its task result records the checkpoint id and the person who confirmed it, and the change reaches `VERIFYING`. The checkpoint record ends as `confirmed`, and no new one is created.
4. `/change verify minding-reading-time-label` passes the evidence gate for `1.3` because a confirmed checkpoint stands in for a builder run and a review, which a person's step never has.

The execute step for a manual task is in [unit-runner.ts](../src/execution/unit-runner.ts): it looks for a confirmed checkpoint before it checkpoints, so resuming does not pause again. The artifact digest treats task progress as not a change, so ticking a checkbox after the first task does not invalidate the run, while any edit to what a task says still does. Tests: `tests/muster/implementation-manual-resume.test.ts`, `tests/review/digest.test.ts` and `tests/review/validator.test.ts`.

## Variant C: a failed task

To see failure records and recovery, make a task fail once with a verification command that cannot pass. After `/change propose` and before `/change review`, edit the task's `verify` line in `tasks.md` to `bun test console/src/lib/domain/doesNotExist.test.ts`, then review and implement. Expected:

- The task ends blocked because verification failed. `.fusion/runs/run-<change>/failures/1.1.json` holds the bounded, redacted evidence, the failing command with its exit code and output tail, and the paths the attempt touched.
- Without judgment nothing else happens: a blocked outcome is final for the run. Restore the verify line, run `/change review` again (the edit made the review stale), and `/change implement` again: the builder's prompt now starts with the failure, and the task completes.
- With judgment in enforce mode, one `task.recovery` request follows the failed attempt. `retry` runs one more attempt in this command (never a third), `escalate` moves the change up a lane and ends the command blocked with `/change review` next, and `stop` ends it blocked with the reason and the failure record's path. In shadow mode the outcome is the same as without judgment, and the decision record shows the answer it would have given.

## Cleaning up

The change branch is never merged by Muster. To discard a job:

```bash
git -C ../minding worktree remove ../.muster-worktrees/minding/<change>
git -C ../minding branch -D muster/<change>
```

Then remove `openspec/changes/archive/<date>-<change>/` and any `openspec/specs/` directory that archiving created, after checking `git status` in minding, and delete `.fusion/runs/run-<change>/`. To keep the job instead, merge `muster/<change>` into minding's `main`.
