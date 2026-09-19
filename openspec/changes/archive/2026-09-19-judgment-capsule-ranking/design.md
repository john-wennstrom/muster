## Context

See `proposal.md` for motivation and for the boundary that shapes this change: capsule assembly is a tested library that no production path calls yet.

The assembler is a pure, synchronous function. It validates the budget and each slice's identifier and token estimate, emits the contract as required content, adds any slice marked required, then walks the slices marked relevant in list order and includes each that fits, and finally lists available and excluded slices by identifier. The escalation check is a separate function that refuses a request for an excluded, unavailable, unknown, or too-large source, and otherwise defers to a caller-supplied authorization callback. Neither has a production caller, and the roadmap marks building slices from real requirements, decisions, code, and dependency reports as unwired.

The judgment layer supplies typed decisions, shadow and enforce modes, audit records, and a fallback for every unavailable reason.

## Goals / Non-Goals

**Goals:**

- Order and demote relevant slices by judged necessity when a ranking is supplied.
- Keep the assembler pure and synchronous, and keep its output identical when no ranking is supplied.
- Give the future wiring one clear call sequence and enough recorded information to measure escalations.

**Non-Goals:**

- Building slices, discovering context, or connecting assembly to the builder. That is the roadmap's wiring item.
- Changing the meaning of required content, the token budget, or exclusion.
- Judging the required-token estimate or any other number; counting stays in code.
- Caching rankings across tasks that share slices.

## Decisions

### 1. Ranking is a separate asynchronous step; the assembler stays pure

A new ranking step asks judgment and returns a ranking. The assembler gains an optional ranking input and remains synchronous and pure, so its existing tests and its determinism are untouched. The future wiring calls the ranking step, then the assembler.

Alternative considered: make the assembler call judgment itself. Rejected because it would make a pure library asynchronous and network-dependent, and every existing assembler test would need a judgment double.

### 2. The packing rule with a ranking

Relevant slices are considered in descending order of rank, where rank is the necessity score multiplied by the confidence, breaking ties by list order, and each is included if it fits — the same greedy fit as today, with a different order. Slices with no ranking have rank zero, so they follow every positively ranked slice in list order. A slice confidently judged unrelated is demoted to on-demand before packing, so unrelated context does not consume budget or distract the builder merely because there was room.

The rubric levels are unrelated, background, useful, and required. The answer is an expectation that can fall between levels, and every threshold in this design is a comparison against it; nothing interpolates it into a magnitude. The initial bands are constants beside the gate: demote below 0.5 at confidence 0.7, report oversized required at 2.5 at confidence 0.7, and authorize escalation at 1.5 at confidence 0.6. They are starting points for calibration, not recommendations.

### 3. The ranking travels with the capsule

The capsule gains two optional fields: the ranking of every slice that was scored, and the list of oversized required slices. Keeping the ranking on the capsule is what lets the escalation authorization consult it without a separate lookup, and it makes a capsule self-describing in a persisted record.

### 4. Escalation authorization is a helper, and the escalation function's checks still run first

A helper builds the authorization callback from a capsule's ranking. The escalation function refuses excluded, unavailable, unknown, and over-budget requests before calling any authorization callback, so the helper can only ever approve among slices the capsule already lists as available and that fit. The helper therefore cannot widen what a task can see. A wrong approval costs tokens, bounded by the remaining budget, not access. The authorization callback stays a required, caller-supplied option; the helper is available to use, not imposed.

### 5. Oversized required is information, not an error

A slice the ranking calls required that does not fit is a signal that the task is too large for one capsule, which plan-time review is better placed to act on. It must not fail assembly, because the ranking is a judgment and required-by-contract content, which already fails when over budget, is a fact. The capsule lists the slice with its score, confidence, and estimate so later stages can use it.

### 6. Slices carry an optional path

A slice gains an optional repository path. File-backed slices set it so the credential denylist can be applied to them; the assembler ignores it. Slices without a path are protected by redaction only, and the security documentation says so. The wiring work should set the path whenever a slice comes from a file.

### 7. Shadow computes both capsules and records the difference

In shadow mode the ranking step assembles both the unranked and the ranked capsule, which is cheap because assembly is pure, records which slices differ, and returns nothing to act on. A reconciliation helper later merges the identifiers of slices that escalation requested, marking each as one the ranking would have included or not. That yields the two numbers the original gate needs: escalations the ranking would have avoided and escalations it would have caused.

### 8. The decision declares two effects

Demotion reduces what a builder is given, which reduces work, and ordering advises which context to prioritize. Neither grants anything. Uncertain rankings do not demote and unranked slices keep list order, so uncertainty falls through to today's behavior.

### 9. State is bounded by count and excerpt

The state holds the task contract and up to thirty slices, each as an excerpt of at most 600 bytes, so a request stays near 8,000 tokens. Slices beyond thirty are unscored. Batching more slices would risk the per-request limit, and answers are independent, so a later change could split slices across calls without altering this design.

## Risks / Trade-offs

- **Dormant until wired** → The library is fully tested with recorded responses, the roadmap gains a note naming the call sequence, and the proposal states the boundary. The risk is neglect, not incorrectness.
- **A wrongly demoted slice hides needed context** → Only confidently unrelated slices are demoted, demoted slices remain available on demand, and shadow data shows how often ranking would have demoted something later escalated.
- **A 600-byte excerpt misses the part of a slice that matters** → An empirical question for calibration; the excerpt size is a constant.
- **Slice identifiers may not be paths** → The optional path field covers file-backed slices, and the documentation states what redaction alone covers.
- **The gate cannot be measured yet** → Stated openly; property tests hold the invariants meanwhile.

## Migration Plan

1. Extend the assembler and escalation modules, with regression and property tests proving identical output without a ranking.
2. Register the decision and add the ranking step with its shadow counterfactual and reconciliation helper.
3. Add the documentation row and the roadmap note, then run the full validation set.

There is nothing to migrate because no production path calls these modules. Rollback is reverting the change. When the roadmap's wiring lands, that work calls the ranking step and enables shadow mode first.

## Open Questions

- Whether rankings should be cached across tasks that share slices. Affects only efficiency, not behavior.
- Whether the escalation bar should differ from the packing bands once escalation data exists. Affects only constants.
