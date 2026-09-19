## Why

When a builder task's context capsule is assembled, the relevant slices are packed in list order: whichever slice the caller listed first that still fits goes in, and everything that does not fit is demoted to "available on demand". Nothing anywhere in that path judges relevance. The caller decides priority by how it built the list, and the authorization callback for later context escalations, also supplied by the caller, has no notion of relevance either.

This is the packing decision that determines what a builder with an eight-hour ceiling sees. Published results for ranking candidates against a query — the same shape as ranking slices against a task — show large gains over unranked candidates, and the savings are not in the ranking call itself but in the builder runs that do not go down the wrong path, the escalations that do not happen mid-run, and the repair cycles that are not triggered.

One fact bounds this change. Capsule assembly is not yet connected to task execution: the assembler consumes supplied slices, nothing builds those slices from real requirements, decisions, code, and dependency reports, and no production path calls the assembler or the escalation check. That wiring is its own roadmap item. This change therefore lands the ranking as a tested library capability and the seam where the wiring will call it, and states plainly that its production effect begins when that wiring exists.

## What Changes

- Rank a task's relevant slices by how necessary each is to completing the task, with one judgment call that scores every slice on an ordered rubric distinguishing necessary from merely related.
- When a ranking is supplied, pack relevant slices by descending necessity multiplied by confidence instead of by list order, and demote slices confidently judged unrelated to on-demand even when budget remains.
- Give slices without a confident ranking today's treatment: they are never demoted, and unranked slices follow ranked ones in list order.
- Leave required content, the token budget, and exclusion exactly as they are, and produce today's capsule whenever no ranking is supplied.
- Report a slice judged required that does not fit, as information on the capsule rather than an error — it usually means the task is too large.
- Offer escalation authorization derived from the stored ranking, approving only slices already available to the task, within the remaining tokens, that clear a lower necessity bar.
- In shadow mode, pack as today and record what ranking would have done, with a way to reconcile the record with the escalations that later occur, so the rate of escalation can be compared once capsule assembly is wired.
- Do not connect capsule assembly to task execution.

## Capabilities

### New Capabilities

- `judgment-capsule-ranking`: How a task's context capsule is packed by relevance when a ranking is available, how slices the ranking judges unnecessary are demoted to on-demand, how oversized required slices are surfaced, and how escalation requests can be authorized from a stored ranking.

### Modified Capabilities

None.

## Impact

- **Context library:** the assembler accepts an optional ranking and reports oversized required slices; the escalation module gains an authorization helper; a new ranking step calls judgment. With no ranking supplied, capsules are identical to today's.
- **Cost:** about $0.0003 for a capsule of thirty slices with 600-byte excerpts, once the wiring exists.
- **Egress:** the task contract and slice excerpts, which can include source, specification text, and dependency reports. Documented in the security documentation.
- **Rollout gate:** the original gate — context escalations drop or hold — cannot be measured until production capsule assembly exists. Until then the gate is property-based: ranking never changes required content, never exceeds the budget, and never changes a capsule when absent. After the wiring lands, shadow records and their escalation reconciliation supply the measurement.
- **Ordering:** depends on `judgment-layer`. Independently revertable, and inert until the capsule wiring calls it.
- **Coordination:** the roadmap's context wiring item is the consumer; this change adds a note there naming the call sequence.
