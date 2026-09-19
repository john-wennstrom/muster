## Why

Four risk booleans drive how much orchestration a planning run spends: whether the request changes a public contract, needs a data migration, changes a security boundary, or leaves a design decision open. Today each is a pattern match over the user's free-text prompt, and each is wrong in both directions.

- A request that says "don't migrate the data, just add a column" matches the migration pattern, classifies as high severity, and escalates to architectural orchestration: specialist opinions and a debate, roughly $0.27 and two extra agent round trips spent on a false positive.
- A request that says "change the wire format between the broker and the child" matches nothing, classifies as direct, drops planning to low thinking and skips optional orchestration. The change is planned badly, fails review, and the whole planning phase runs again.

Both errors cost money, and they are decided by keywords rather than by what the request means.

## What Changes

- Determine each of the four risk inputs by typed judgment when the judgment is confident: a confident yes sets the input, a confident no clears it.
- When judgment is not confident about a signal, use the existing pattern value for that one signal. The uncertain middle costs exactly what it costs today, and other signals are unaffected.
- Keep design ambiguity scoped to refinement, as the pattern is today: it is judged in every phase but applied only when refining.
- Ask two further questions in the same call — how mechanical the change is and how far it reaches — and record their answers without letting them influence classification.
- Run first in shadow mode, recording the judged value beside the pattern value for every signal, so agreement is measurable across real changes before enforce is used.
- Leave the classification ladder, the override mechanism, and the orchestration policy exactly as they are. Only the four inputs change.

## Capabilities

### New Capabilities

- `judgment-complexity`: How the four risk inputs to complexity classification are determined from the request — judged when confident, falling back per signal to pattern matching — without changing the classification ladder, overrides, or orchestration policy.

### Modified Capabilities

None.

## Impact

- **Planning phase:** one judgment call between the preflight evidence becoming known and classification. Nothing else in planning changes.
- **Cost:** about $0.00005 per planning run, against a mis-escalation of about $0.27 or a failed review and re-plan.
- **Egress:** the effective request text (on refinement this includes the previous review's required changes), the phase, and the preflight evidence paths and reasons. Documented in the security documentation.
- **Compatibility:** with judgment disabled, unavailable, or in shadow mode, classification is identical to today's for every input.
- **Rollout gate:** enforce is recommended only after shadow agreement has been measured across at least twenty real changes and the disagreements reviewed.
- **Ordering:** depends on `judgment-layer`. Independently revertable: removing the single call restores the pattern-only behavior.
- **Coordination:** the planning phase module has edits in flight at the time of writing; this change should be implemented on top of them.
