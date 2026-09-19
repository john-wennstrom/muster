## Context

See `proposal.md` for motivation and for the two facts that shape this change.

The builder step selects the model directly: it takes the primary builder slot from the resolved model stack, runs a brokered child with an eight-hour ceiling, and records usage under that model. Model resolution lives in one module: an environment override per role wins over a configured model-stack slot, which wins over a command-line flag, which wins over one declared fallback per role, and the module already has a helper that copies a slot with a different model, used to apply environment overrides. The project's guidance is that no phase adds a competing default.

The capability router is a library with no production caller. It filters candidates by role, availability, authentication, context size, tool support, and a cost ceiling, then sorts by ascending estimated input cost, so it already prefers the cheapest eligible model. It has no notion of model quality.

The scheduler passes each task's attempt number to the implementation phase, which currently ignores it; tasks are allowed two attempts. A task's pipeline ends in an outcome that is completed, blocked, awaiting the user, or a design conflict.

The judgment layer supplies typed decisions, shadow and enforce modes, an optional per-decision enabling flag, audit records, reconciliation, and a fallback for every unavailable reason.

## Goals / Non-Goals

**Goals:**

- Let the cheapest, most mechanical tasks run on a cheaper model that the user has chosen, and nothing else.
- Make every guard a confident yes or no, so uncertainty always means the primary builder.
- Make the quality effect measurable per lane before and after enforcement.

**Non-Goals:**

- Choosing or discovering an economy model. It exists only when the user configures it.
- Lowering the thinking level on the economy lane. Changing only the model keeps the effect attributable.
- Changing the model router or connecting it to production.
- Configuring the lane through the model-stack YAML. This change resolves it from an environment override only.
- Routing any role other than builder.

## Decisions

### 1. Integrate at the builder step, not the router

The router is unused in production, already prefers the cheapest model, and has no quality data, so a routing preference added there would be dead code that could not express the intent. The builder step's model choice is the decision that production actually makes. Integrating there also means the change affects exactly the path that runs, and the router library is left alone.

Alternative considered: add a task-profile field to the router's request. Rejected because no production code would honor it, and its only possible effect — preferring cheaper models — is already the router's ordering.

### 2. The economy lane is a second configured slot, never an inferred one

The lane is the primary builder's slot copied with the model named by a dedicated environment override, using the same copy helper that applies other overrides, so its thinking level, prompts, and tool configuration are the primary's. With no override there is no lane and routing is inert. Because the lane exists only by explicit configuration, the declared role fallback stays what it is and judgment can only choose between two models a person named or defaulted to — never step below a floor, and never introduce a model on its own.

### 3. A per-task call at build time, independent of other integrations

One call per task, just before the builder runs, over the task's contract. It does not depend on the complexity judgment or on any other integration's flag or records, because the complexity judgment is about the whole request and each task needs its own answer. This keeps the change independently shippable and revertable, at a cost of about a hundredth of a cent per task.

### 4. Seven questions and a conjunction of guards

Six yes/no questions ask whether the task could be carried out by following a stated pattern without design judgment, whether it needs deep reasoning, whether it needs a large context, whether it needs a novel design, whether it changes what an actor may do or what is trusted, and whether it changes an externally observable contract. A four-level rubric asks how far it reaches.

The gate is a conjunction: mechanical above 0.8, each of the five risk questions below 0.3, reach below 1.5 at confidence 0.8. The original proposal names the security, contract, and reach guards; the deep-reasoning, large-context, and novel-design answers are natural blockers for a downgrade and cost nothing extra, so they are guards too. Every guard needs a confident answer, so any uncertainty routes to the primary builder. Bands are constants beside the gate and are starting points.

### 5. First attempts only, which requires the attempt number

The implementation phase passes the attempt number to the builder step, which currently ignores it. A second or later attempt uses the primary builder without a routing call. This means a task that failed on the economy lane is retried on the stronger model and never downgraded because it failed.

### 6. The decision declares one effect

Routing a task to a cheaper model reduces the spend on the same work, which is the direction of the "reduces work" effect. It falls through to the primary builder whenever it abstains.

### 7. Reconciliation by task at pipeline outcome

When a task's first-attempt pipeline finishes, the implementation phase finds that task's most recent routing record and merges the lane and the outcome into it. No state is threaded through the builder result. A report groups first-attempt completion by lane; in shadow runs, every task ran on the primary builder, so the report gives the baseline rate for tasks that would have been routed, and enforce runs supply the economy lane's rate to compare against it.

### 8. Cost attribution needs nothing new

Usage records already carry the model that ran each builder, so the price difference per lane is derivable from existing records without new fields.

## Risks / Trade-offs

- **A quality regression on routed tasks** → The guard conjunction, first attempts only, retries on the primary, the explicit-lane requirement, the flag, shadow before enforce, and a success-rate gate that compares lanes.
- **Misjudging a task as mechanical** → Every risk guard must also be a confident no, and a failure on the economy lane is retried on the primary builder within the task's two attempts.
- **The user's economy model lacks the tools or context a task needs** → Choosing a model that supports the builder's tools is the user's responsibility when configuring, and the documentation states it; a failure retries on the primary.
- **The most quality-sensitive change in the rollout** → It is last, flag-gated, and off unless a person configures a lane.
- **A small change to the eight-hour builder path** → Optional at every hop, byte-identical when disabled, and tested at the builder step.

## Migration Plan

1. Add lane resolution to the model-resolution module, with tests beside the existing resolution tests.
2. Register the decision with its guards.
3. Pass the attempt number to the builder step and add the routing choice, with shadow, enforce, retry, and fallback tests.
4. Reconcile outcomes in the implementation phase and add the per-lane report.
5. Document the flag, the override, and the egress, then run the full validation set.

Rollout: shadow first to learn what share of tasks would be routed and their baseline first-attempt success; enable a lane and enforce for a limited set of changes; compare the lanes' first-attempt success. Rollback: unset the flag or the override, or revert; nothing persistent depends on the lane.

## Open Questions

- Whether a later change should let the economy lane be configured through the model-stack YAML as well. It would add a configuration surface and a requirement, so it would be a separate change.
