## Why

Every builder task in a change runs on the same model. A one-line configuration edit and a cross-capability refactor are dispatched identically, so the cheapest tasks pay frontier-model prices for work that follows a pattern. Most tasks in most changes are like that, which makes this the largest potential saving of the whole rollout on a multi-task change — and also the one with the greatest risk to quality, which is why it comes last and is guarded most heavily.

Two facts about the current system shape what this change can be. First, the harness's model router is not on the production path: it is a tested library, and the builder step selects the model directly, always taking the primary builder. Second, the router already sorts by ascending cost, so a "prefer the cheaper model for mechanical tasks" hint would change nothing, and there is no quality data on which a "prefer the stronger model for hard tasks" hint could act. The decision point that matters is the builder step's choice of model, and the only cheaper option that exists is one the user configures.

## What Changes

- Add an optional economy builder lane: a cheaper model that exists only when the user configures it explicitly, resolved with the same rules as the other model roles and inheriting the primary builder's thinking level, prompts, and tool configuration. The harness never infers, defaults, or chooses an economy model.
- Before a builder task runs, ask a typed judgment about that one task: how mechanical it is, whether it needs deep reasoning or a large context or a novel design, whether it touches a security boundary or a public contract, and how far it reaches.
- Route a task to the economy lane only when every guard holds: it is confidently mechanical, confidently free of each risk, narrow in reach, and on its first attempt. Anything uncertain, and every retry, uses the primary builder.
- Send nothing and change nothing unless routing has its own enabling flag, judgment is enabled, and an economy model is configured.
- Record each routing decision per task and reconcile it with the task's first-attempt outcome, so the task success rate can be compared between lanes and against the primary builder's baseline.
- Run first in shadow mode: the primary builder is always used while the lane that would have been chosen is recorded.
- Leave the model router library alone.

## Capabilities

### New Capabilities

- `judgment-model-routing`: How a builder task may be routed to an explicitly configured economy model when a typed judgment confidently finds it mechanical and low-risk, and the guards that keep every other task on the primary builder.

### Modified Capabilities

None.

## Impact

- **Model resolution:** a new optional lane resolved beside the existing roles, with its own environment override and no default.
- **Builder step:** an optional judgment call and a lane choice before the builder runs; the builder's timeout, prompt, scopes, and result handling are unchanged. The attempt number, currently ignored, reaches the builder step.
- **Implementation phase:** each task's first-attempt outcome is reconciled against its routing record.
- **Cost:** the judgment costs about $0.0001 per task. The saving is the difference in model price on routed tasks, visible in existing usage records, which already name the model that ran.
- **Egress:** each task's description, requirements, scenarios, scopes, and verification commands. No source. Documented in the security documentation.
- **Quality risk:** the highest of the rollout for output quality, which is why it needs its own flag, an explicit lane, a conjunction of guards, first attempts only, and a success-rate gate.
- **Rollout gate:** flag-gated, and the task success rate holds — the share of routed tasks that complete on the first attempt is compared with the primary builder's share for the same kind of task.
- **Ordering:** depends on `judgment-layer`. Independently revertable.
