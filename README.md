# muster

Muster is a OpenSpec-driven multi-agent development workflows for Pi. The preferred workflow surface is `/change`.

## Workflow

A development controller derives the current lifecycle of a change from a validated `ChangeSnapshot` — OpenSpec status, Git/worktree identity, review verdict, task state, and verification evidence — rather than from anything a model reports. Every `/change` subcommand asks the controller whether the change's current lifecycle allows that action before doing any work, and tells you the next allowed command when it does not.

```text
Usage: /change <explore|propose|refine|review|implement|verify|finish|status|resume> [change] [arguments]
```

1. **`/change explore <prompt>`** — read-only investigation with no OpenSpec artifacts and no lifecycle change. Use it to understand a problem before committing to a change.
2. **`/change propose <change> [lane=small|medium|large] <goal>`** — chooses the change's lane, then creates the OpenSpec proposal, specs, design, and tasks for a new change (`PLANNING`).
3. **`/change refine <change>`** — revises those artifacts while `PLANNING`, `REVIEW_REQUIRED`, `DESIGN_CONFLICT`, or `BLOCKED`.
4. **`/change review <change>`** — runs plan lint over the artifacts, then approves the plan: an independent, fresh-context reviewer on the medium and large lanes, or lint plus one semantic check on the small lane. It records an artifact digest with an `APPROVE` or `REVISE` verdict (`REVIEW_REQUIRED` → `READY` on approval).
5. **`/change implement <change>`** — compiles the tasks into a dependency DAG and executes dependency-ready tasks in a dedicated change worktree, one writer-leased task at a time, with fresh builder sessions and focused verification per task (`READY`/`IMPLEMENTING`).
6. **`/change verify <change>`** — runs fresh-context final verification against the change's requirements and scenarios and writes a durable verification artifact (`VERIFYING` → `VERIFIED`).
7. **`/change finish <change>`** — confirms a current `VERIFIED` digest and delegates archiving to OpenSpec. It never runs automatically after verification.
8. **`/change status <change>`** — reports the current lifecycle, review/validation freshness, and any pending checkpoints without changing state.
9. **`/change resume <change> <checkpoint-id>`** — an explicit user confirmation that continues a task branch paused at `AWAITING_USER`.

```text
EXPLORE
  -> PLANNING -> REVIEW_REQUIRED -> READY -> IMPLEMENTING -> VERIFYING -> VERIFIED -> FINISHING -> COMPLETE
```

`AWAITING_USER`, `DESIGN_CONFLICT`, `BLOCKED`, `FAILED`, and `CANCELLED` are side states tracked per task/DAG branch, so unrelated branches can keep making progress. A task enters `AWAITING_USER` whenever it would require secrets/authentication, elevated privileges, a destructive action, or an external side effect, or whenever a design conflict needs a human decision — the affected branch pauses with persisted, secret-free instructions until `/change resume` explicitly confirms it. Any change to a reviewed artifact reopens `REVIEW_REQUIRED`, and any relevant post-verification change invalidates `VERIFIED`.

## Planning cost controls

`/change propose` and `/change refine` first choose the change's **lane**, before any agent runs: `small`, `medium` or `large`. Code retrieves up to ten candidate files from the request's identifiers, a pattern classification over those files and the request text sets the floor, and, when judgment is enabled, one typed judgment request can raise the lane on any confident risk and lower it to `small` only when every risk and the reach were judged with confidence. Without judgment the lane is `medium`, or `large` when the patterns say architectural. `large` adds specialist opinions and a debate before synthesis. The lane is recorded with the change's run records, shown by `/change status`, and can only move up.

You can choose the lane yourself with a plain argument right after the change name: `/change propose <change> lane=small <goal>` (the same for `refine`). It overrides triage and sends no judgment request; an unrecognized lane name is rejected with the usage line.

Then one planning session returns a **typed plan** as data: a summary, requirements with named scenarios, an optional design, and tasks with their full metadata. The session can instead ask one specific question, or report that the checked-out repository already satisfies the request, and either stops the command without writing anything. Code validates the plan before anything is written: task references resolve to the plan's requirements and scenarios, identifiers are unique, dependencies are acyclic, and every verification command uses an executable the verification profile allows. A failure goes back to the session once, as a list of the specific errors, and a second failure ends the command with that list. Code then renders the proposal, one delta specification per capability, the design and the task list from templates under `prompts/artifacts/`, so every lane writes all four artifacts and the session never chooses a path. A `large` change runs specialist opinions and a debate first; `small` and `medium` do not.

## Plan review and lint

`/change review` first runs **plan lint**, a deterministic check over the artifacts on disk, on every lane: the artifacts exist and pass `openspec validate --strict`, every task reference resolves against the change's real specification files, every scenario is cited by a task, verification commands are allowed, write scopes avoid credential files and `.git`, and the dependency graph is acyclic. A failure ends the command with the whole list, before any reviewer or judgment request.

On the `small` lane the plan is then approved by lint plus one `plan.lint` judgment request (the six task-quality concerns), and no reviewer runs: a clean, confident answer, or an unavailable service, records a lint approval in `review.md` (mode `lint`, model `lint`, the checks that ran, and whether the semantic check ran). A confident finding, an uncertain concern, or a plan over the lane's limits (two tasks, no manual tasks) escalates the change to `medium` and runs the reviewer with the findings as unverified notes. An escalation makes an existing lint approval stale, so the next `/change review` dispatches the reviewer. On `medium` and `large` the reviewer always runs, and the semantic check's findings are only notes to it.

Planning defaults to a 1,000,000-token / $1.50 phase forecast limit. Override these with `MUSTER_PLANNING_MAX_TOKENS` and `MUSTER_PLANNING_MAX_COST_USD`, or with `--planning-max-tokens` and `--planning-max-cost`. Direct and bounded planning use lower thinking levels; configured architect thinking remains in effect for architectural work.

## The small lane, end to end

A `small` change is the cheapest path through the pipeline and keeps every deterministic check. `/change propose` makes one plan session (no opinions, no debate) and code renders the artifacts. `/change review` approves it with plan lint and one semantic check instead of a reviewer. `/change implement` starts one builder session per task; a small change has at most two tasks, and same-scope chained tasks are merged when the plan is normalized, so one task is typical. When judgment finds the finished task confidently good on every question, its review is skipped as described below, so a one-task small change can cost two model sessions from proposal to verification. Anything the lane cannot vouch for moves the change up: a lint finding, a task failure the recovery decision escalates, or a plan over the lane's limits. A lane only ever moves up.

## Judgment modes

Judgment is optional. It is enabled by `MUSTER_JEV=1` and `MUSTER_JEV_API_KEY`, and once enabled it **enforces by default**: a confident answer changes what the harness does, within the limits each decision documents. `MUSTER_JEV_MODE=shadow` selects shadow mode instead, which sends the same requests and records what each answer would have done without acting on any. With judgment unset, or when the service is unavailable, uncertain, or over budget, the pipeline does exactly what it does without it. No answer can grant a permission, remove a manual checkpoint, or relax a deterministic check; the [security model](docs/security.md) lists every call site and what it sends.

## When a task fails

Every task attempt that does not complete leaves a **failure record** under the run's `failures/` directory: how it ended, bounded and redacted evidence, the command that reproduces the failure with its exit code and output tail, what the builder said it changed, and the paths it touched. The two latest are kept, and the next attempt's builder prompt includes the latest one, whether it is an automatic retry or a later `/change implement`. A thrown attempt is retried once, as always. With judgment in enforce mode, one `task.recovery` request after a failed attempt can also choose to retry once more when verification failed or the reviewer required repairs (never beyond two attempts in a run), to escalate the change to the next lane so it is reviewed again (the command ends blocked and points to `/change review`), or to stop for a person with the reason and the failure record's path.

## Model configuration

Each role's model is resolved in one order: an environment override (`MUSTER_ARCHITECT_MODEL`, `MUSTER_BUILDER_MODEL`, `MUSTER_REVIEWER_MODEL`, `MUSTER_VALIDATOR_MODEL`), then a configured model stack (`--fh-config`), then the `--architect` and `--builder` flags, then one declared fallback per role.

Two optional **economy models** can run the most mechanical work more cheaply. They exist only when you name them: `MUSTER_BUILDER_ECONOMY_MODEL` for a task's builder and `MUSTER_REVIEWER_ECONOMY_MODEL` for its reviewer. Each is independent of the other, and Muster never infers, defaults, or chooses one. An economy lane is the primary role with only the model replaced, so its prompts and tools are the primary's; its thinking level is chosen per task. Choosing models that support the tools is your responsibility.

When judgment is enabled (`MUSTER_JEV=1` and `MUSTER_JEV_API_KEY`), one routing judgment per task, made before its first attempt, chooses how hard the builder and the reviewer think. A task judged mechanical, low-risk, and narrow gets builder thinking low and reviewer thinking medium; a mechanical, low-risk task of moderate reach gets builder medium and reviewer high. Such a task also runs on an economy model where you configured one. Everything else keeps the configured builder thinking and a high reviewer. A retry, a change on the large lane, and `MUSTER_JEV_MODE=shadow` (which only records what would have been chosen) always use the configured thinking and the primary models. Judgment acts (enforce mode) unless you select shadow. With judgment unset, every task runs exactly as configured.

In enforce mode the same judgment of a finished task can **skip its review**, but only when every check holds: every focus question was answered confidently with its good value, the lane permits reduced work, verification passed, the test-first evidence was accepted, the diff is complete and inside the task's write scope with no credential-like path, and it is the task's first attempt. A skipped review is recorded as skipped (no reviewer read the diff), and final validation accepts it only on a lane that permits reduced work. What is sent for each judgment is listed in the [security model](docs/security.md).

## Security boundary

Agents use the standard Pi tools by default: `read`, `grep`, `find`, and `ls` for read-only work; writers also receive `bash`, `edit`, and `write`. Validators additionally receive `write`. Global and per-slot `child.extensions` and `child.tools` settings apply. Scope and gate submission remain harness tools.

Standard agent tools run directly on the host. Profiled host commands are brokered and audited; these controls do not provide operating-system process or network isolation. Standard tool operations do not pass through the broker's per-operation path and command checks. Writer leases still serialize writing tasks. See the [security model](docs/security.md) for details.

OCI or native process and network isolation is a non-blocking post-beta hardening item behind the command-runner interface. It is tracked in the [roadmap](docs/roadmap.md) and is not a beta capability.

Validate documentation links, command examples, and security wording with:

```text
bun run docs:check
```

The complete local and cross-platform checks are in the [testing guide](docs/testing.md).

## Retired commands

`/change` is the only command family. The commands `/refine`, `/implement`, `/ship`, `/os-status`, `/init` and every `/fh-*` command were removed and are not aliased. Use `/change refine`, `/change implement`, `/change finish` and `/change status` for the lifecycle, and `/change explore` for read-only investigation. Model selection that `/fh-model` and `/fh-only` offered is configured through the model-stack YAML (`--fh-config`) and the `--architect` and `--builder` flags, which keep their names.
