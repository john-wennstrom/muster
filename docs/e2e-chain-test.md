# End-to-end chain test: reading-time helper in minding

A small, real job for running every `/change` command once against a real repository, the sibling `minding` checkout. The job adds one pure TypeScript helper and its tests to minding's console. It is small enough to finish in minutes, but it has two dependent tasks, so it exercises the task DAG, the writer lease, the change worktree, task review, final verification and archiving. The flow of each command is drawn in [command-flow.md](command-flow.md).

Nothing in this document has been run. The steps and expected results come from reading the code, and each step says what to check so a mismatch is easy to spot.

## Why this job

Three things about how Muster verifies work shaped the choice:

- **Verification commands cannot run `cargo`.** The `verification` command profile allows only `bun`, `node`, `npm`, `npx`, `git` and `openspec` ([command-profile.ts](../src/tools/command-profile.ts)). A Rust job in minding could be built but never verified. The console is TypeScript with `bun test`, so the job lives there.
- **`/change verify` always appends a full `bun test` at the worktree root.** In minding that runs every test under `console/`. A fresh worktree has no `node_modules`, so that run fails with about 20 "Cannot find package" errors until you install the console's dependencies inside the worktree. The runbook does this before `verify`. With dependencies installed, the full suite passes on the current `HEAD` (368 tests).
- **The console's `src/lib/domain/` layer is pure TypeScript.** `console/CLAUDE.md` in minding forbids React, fetch and server types there, so the tests need no dependencies and the job cannot break anything else.

The job is also disjoint from the uncommitted work currently in minding's `console/`. The change worktree starts from `HEAD`, so that work is not in it.

## The job

Add `console/src/lib/domain/readingTime.ts` and `console/src/lib/domain/readingTime.test.ts`:

| Function | Behavior |
| --- | --- |
| `estimateReadingTime(wordCount, wordsPerMinute = 238)` | Whole minutes, rounded up. `0` for 0 words, at least `1` for any positive count. `RangeError` for a negative, `NaN` or infinite word count, or a words-per-minute that is not a positive finite number. |
| `formatReadingTime(minutes)` | `0` gives `No reading time`. `1` to `59` gives `N min read`. `60` or more gives `H h M min read`, or `H h read` when the remainder is 0. `RangeError` for a negative, fractional or non-finite input. |

Two tasks, the second depending on the first, each verified by one command that runs from the repository root: `bun test console/src/lib/domain/readingTime.test.ts`.

## Before you start

1. Tools on `PATH`: `pi`, `openspec`, `bun` 1.4.
2. Model credentials for the roles you use. Muster resolves each role from `MUSTER_ARCHITECT_MODEL`, `MUSTER_BUILDER_MODEL`, `MUSTER_REVIEWER_MODEL` and `MUSTER_VALIDATOR_MODEL`, then from `--fh-config`, then from `--architect` and `--builder`, then from a declared fallback ([models.ts](../src/change/models.ts)). minding already has a stack at `.pi/fusion-harness/model-stack-fusion.yaml`.
3. A launch that loads Muster from this repository while working in minding:

```bash
cd ../minding
pi -e <path-to-muster>/src/muster/index.ts --fh-config .pi/fusion-harness/model-stack-fusion.yaml
```

The global Pi settings list `/media/john/Projects/fusion-harness` as a package and as an extension, and that path does not exist on this machine. If Pi complains about it or registers the commands twice, add `-ne` so only the explicit `-e` extension loads. This launch line is untested.

4. Note minding's current `git status`. The job leaves minding's working tree alone until `finish`, when OpenSpec writes into `openspec/`.

## The prompt

Paste this after `/change propose`. It is one line so it survives any input box, and it pins the plan to the shape above.

```text
/change propose minding-reading-time Add a pure reading-time helper to the console domain layer. Create console/src/lib/domain/readingTime.ts and console/src/lib/domain/readingTime.test.ts. estimateReadingTime(wordCount: number, wordsPerMinute = 238): number returns whole minutes rounded up, returns 0 when wordCount is 0 and at least 1 for any positive wordCount, and throws RangeError when wordCount is negative, NaN or infinite or wordsPerMinute is not a positive finite number. formatReadingTime(minutes: number): string returns "No reading time" for 0, "N min read" for 1 to 59, "H h M min read" for 60 or more and "H h read" when the remainder is 0, and throws RangeError for a negative, fractional or non-finite input. Constraints: pure TypeScript with no imports, per the domain layering rule in console/CLAUDE.md; do not touch any component, route, generated file, Rust crate or manifest; add no dependencies. Plan exactly two tasks: task 1.1 writes the failing tests first and then estimateReadingTime, and task 1.2 depends on 1.1 and does the same for formatReadingTime. Every task must have exactly one verify command, which is: bun test console/src/lib/domain/readingTime.test.ts (the verification profile allows only bun, node, npm, npx, git and openspec, and runs from the repository root).
```

## Runbook

Run these in order, in the Pi session started above.

| # | Command | Expect | Check |
| --- | --- | --- | --- |
| 1 | `/change explore Where do pure formatting helpers live in console/src/lib/domain, what do their tests look like, and is there already a reading-time or word-count helper?` | A success panel with a read-only answer. No lifecycle, no change. | `openspec list` shows no new change and `git status` in minding is unchanged. |
| 2 | `/change status minding-reading-time` | Refused or failed, naming a change that does not exist. | Nothing was created. This is the "unknown change" guard. |
| 3 | The `/change propose` line above | Preflight says `proceed`. The change is complexity `direct` (2 files, 1 capability), so there are no specialist opinions and no debate. Success, next `/change review minding-reading-time`. | `openspec/changes/minding-reading-time/` holds `proposal.md`, `design.md`, `tasks.md` and one `specs/*/spec.md`. `tasks.md` has tasks `1.1` and `1.2`, each with a `harness-task` block, `1.2` has `dependsOn: ["1.1"]`, and both verify lines are the one command. `openspec validate minding-reading-time --strict` passes. |
| 4 | `/change implement minding-reading-time` | Blocked: no current approved `review.md`. Next `/change review minding-reading-time`. | The lifecycle gate refuses before any worktree is created. |
| 5 | `/change refine minding-reading-time Also require tests that estimateReadingTime(1) is 1, that wordsPerMinute = 1 works, and that formatReadingTime(60) is "1 h read".` | Success, next `/change review`. | The requested cases appear in `specs/*/spec.md` and `tasks.md`. |
| 6 | `/change review minding-reading-time` | `APPROVE`, next `/change implement`. On `REVISE`, run `/change refine minding-reading-time` with no text (it folds the required changes in by itself) and review again. | `review.md` exists with a `round`, the reviewer's model and an artifact digest. A model other than the author's is preferred, but minding's stack puts every slot on one model, so the reviewer is that model in a fresh session. |
| 7 | `/change status minding-reading-time` | `Lifecycle: READY`, `Review: current`, `Validation: missing`, `Pending checkpoints: 0`, and usage totals for planning. | |
| 8 | `/change implement minding-reading-time` | A change worktree is created, task `1.1` runs and completes, then `1.2`. Success, next `/change verify`. | See below. |
| 9 | Install the console's dependencies in the worktree (below). | | |
| 10 | `/change verify minding-reading-time` | `Final verification PASS`, next `/change finish`. | `verification.md` and `validation.json` exist. `/change status` shows `Lifecycle: VERIFIED`. |
| 11 | `/change finish minding-reading-time` | `Archived minding-reading-time as ...`. | `openspec/changes/archive/` has the archived change. |

After step 8, check:

- The worktree is `../.muster-worktrees/minding/minding-reading-time` on branch `muster/minding-reading-time`, created from minding's `HEAD`. `git -C` that path shows the two new files under `console/src/lib/domain/`.
- Both checkboxes in the change's `tasks.md` are ticked, in the planning checkout, not the worktree.
- Under minding's `.fusion/runs/run-minding-reading-time/` there are `manifest.json`, `task-results/`, `reviews/`, `tdd/`, `reports/` and `usage/`. Each task has a TDD record showing the tests failed before the implementation.
- `1.2` did not start before `1.1` finished.

For step 9, before `/change verify`:

```bash
cd ../.muster-worktrees/minding/minding-reading-time/console && bun install --frozen-lockfile
```

`node_modules` is ignored by Git, so this does not change the worktree's source digest and does not make verification stale.

## What each command should have proved

| Command | Proved by |
| --- | --- |
| `explore` | Step 1: a read-only agent ran, and no change or lifecycle came into being. |
| `propose` | Step 3: the change exists with valid, strictly validated artifacts and a parseable task DAG. |
| `refine` | Step 5: the artifacts changed and the next step is review. |
| `review` | Step 6: a fresh reviewer wrote a verdict bound to the artifact digest. |
| `implement` | Step 8: the worktree, the writer lease, the fresh builder per task, the TDD evidence, the focused verification, the task review, and the ticked checkboxes. |
| `verify` | Step 10: all nine final-validation gates passed, including the full `bun test`. |
| `finish` | Step 11: the archive, and the digest freshness check before it. |
| `status` | Steps 2 and 7, and again after each later step. |
| lifecycle gates | Steps 2 and 4: a command refused with a specific reason and the exact next command. |

`resume` is not reached by this path. See variant B.

## Variant A: with judgment on

Run the whole chain a second time under a new change name, for example `minding-reading-time-jev`, so the two runs do not share a run store. Set these in the shell before launching Pi:

```bash
export MUSTER_JEV=1
export MUSTER_JEV_API_KEY=<your key>
export MUSTER_JEV_MODE=shadow
export MUSTER_JEV_REVIEW_TRIAGE=1
```

Judgment sends repository content to a third-party classifier. Read [the judgment egress section of the security model](security.md#judgment-egress) first, and confirm that minding's code may leave the machine.

In `shadow` mode every call is evaluated and recorded but nothing changes behavior, so the outcome should match the first run. The decision records are under `.fusion/runs/run-<change>/judgment/`. Expect records for:

| Decision | From |
| --- | --- |
| `planning.preflight`, `planning.complexity`, `planning.task_quality` | propose and refine |
| `review.triage` | a second `/change review` after a prose-only edit to `proposal.md` or `design.md`, once the first review approved |
| `command.classification` | each brokered host command during implement |
| `review.task_focus` | each task's review during implement |

`review.extraction` fires only when a reviewer returns unstructured output, and `routing.task_model` needs `MUSTER_JEV_MODEL_ROUTING=1` and `MUSTER_BUILDER_ECONOMY_MODEL`, so neither is expected unless you set those. `context.capsule_ranking` and `debugging.thrash` are not connected and produce no records.

Then repeat with `MUSTER_JEV_MODE=enforce` and compare. In enforce mode the preflight agent may be skipped, task-quality findings may appear in the propose outcome, and a prose-only edit after an approved review may be carried forward without a reviewer.

## Variant B: a manual checkpoint and `resume`

To reach `AWAITING_USER`, add this sentence to the end of the propose prompt: "Add a third task 1.3 that depends on 1.2, has role manual, and carries a manual block with category design_decision that asks the owner to confirm the label wording."

Then run the same steps. Expected:

1. `/change implement` completes `1.1` and `1.2`, then stops. The outcome is blocked with a pending checkpoint, `/change status` shows `Lifecycle: AWAITING_USER` and lists the checkpoint id, and the checkpoint instructions contain no secrets.
2. `/change implement minding-reading-time` is now refused with the pending checkpoint id, because only `resume` is allowed.
3. `/change resume minding-reading-time <checkpoint-id>` records who confirmed the checkpoint and runs the flow again. Task `1.3` completes from the confirmation instead of pausing a second time: its checkbox is ticked, its task result records the checkpoint id and the person who confirmed it, and the change reaches `VERIFYING`. The checkpoint record ends as `confirmed`, and no new one is created.
4. `/change verify minding-reading-time` passes the evidence gate for `1.3` because a confirmed checkpoint stands in for a builder run and a review, which a person's step never has.

Two problems used to make this variant fail, and both are fixed. The execute step in [implementation.ts](../src/change/phases/implementation.ts) checkpointed any task with a `manual` block without first looking for a confirmed checkpoint, so resuming paused again. And the artifact digest covered the raw bytes of `tasks.md`, so ticking a checkbox after the first task changed the digest and made the next `implement` or `resume` treat the run as invalidated. The digest now treats task progress as not a change, while any edit to what a task says still changes it. Tests: `tests/muster/implementation-manual-resume.test.ts`, `tests/review/digest.test.ts` and `tests/review/validator.test.ts`.

## Cleaning up

The change branch is never merged by Muster. To discard the job:

```bash
git -C ../minding worktree remove ../.muster-worktrees/minding/minding-reading-time
git -C ../minding branch -D muster/minding-reading-time
```

Then remove `openspec/changes/archive/<date>-minding-reading-time/` and any `openspec/specs/` directory that archiving created, after checking `git status` in minding, and delete `.fusion/runs/run-minding-reading-time/`. To keep the job instead, merge `muster/minding-reading-time` into minding's `main`.
