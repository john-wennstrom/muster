# muster

Muster is a OpenSpec-driven multi-agent development workflows for Pi. The preferred workflow surface is `/change`.

## Workflow

A development controller derives the current lifecycle of a change from a validated `ChangeSnapshot` — OpenSpec status, Git/worktree identity, review verdict, task state, and verification evidence — rather than from anything a model reports. Every `/change` subcommand asks the controller whether the change's current lifecycle allows that action before doing any work, and tells you the next allowed command when it does not.

```text
Usage: /change <explore|propose|refine|review|implement|verify|finish|status|resume> [change] [arguments]
```

1. **`/change explore <prompt>`** — read-only investigation with no OpenSpec artifacts and no lifecycle change. Use it to understand a problem before committing to a change.
2. **`/change propose <change>`** — creates the OpenSpec proposal, specs, design, and tasks for a new change (`PLANNING`).
3. **`/change refine <change>`** — revises those artifacts while `PLANNING`, `REVIEW_REQUIRED`, `DESIGN_CONFLICT`, or `BLOCKED`.
4. **`/change review <change>`** — runs an independent, fresh-context planning review over the proposal/specs/design/tasks and records an artifact digest with an `APPROVE` or `REVISE` verdict (`REVIEW_REQUIRED` → `READY` on approval).
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

`/change propose` runs a bounded read-only preflight before creating a change. It stops with a specific question when the requested behavior is ambiguous or already present in the checked-out repository. When planning proceeds, OpenSpec creates the change and supplies the instructions and templates for every generated artifact.

Planning defaults to a 100,000-token / $0.50 phase forecast limit. Override these with `MUSTER_PLANNING_MAX_TOKENS` and `MUSTER_PLANNING_MAX_COST_USD`, or with `--planning-max-tokens` and `--planning-max-cost`. Direct and bounded planning use lower thinking levels; configured architect thinking remains in effect for architectural work.

## Model configuration

Each role's model is resolved in one order: an environment override (`MUSTER_ARCHITECT_MODEL`, `MUSTER_BUILDER_MODEL`, `MUSTER_REVIEWER_MODEL`, `MUSTER_VALIDATOR_MODEL`), then a configured model stack (`--fh-config`), then the `--architect` and `--builder` flags, then one declared fallback per role.

An optional **economy builder lane** can run the most mechanical tasks on a cheaper model. It exists only when you name a model with `MUSTER_BUILDER_ECONOMY_MODEL`; Muster never infers, defaults, or chooses one. The lane is the primary builder with only the model replaced, so its thinking level, prompts, and tools are the primary builder's. Choosing a model that supports the builder's tools is your responsibility.

Tasks are routed to the lane only when `MUSTER_JEV_MODEL_ROUTING=1` is set alongside `MUSTER_JEV` and `MUSTER_JEV_API_KEY`, the lane is configured, and a typed judgment confidently finds the task mechanical, low-risk, and narrow in reach. Only a task's first attempt is eligible, a retry always uses the primary builder, and `MUSTER_JEV_MODE=shadow` (the default) routes nothing and only records the lane that would have been chosen. With any of these unset, every task uses the primary builder exactly as before. What is sent for a routing judgment is listed in the [security model](docs/security.md).

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
