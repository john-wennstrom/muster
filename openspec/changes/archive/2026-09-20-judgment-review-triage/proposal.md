## Why

A planning review is bound to a digest of the change's planning artifacts: the proposal, the design, the task list, and every delta specification. Any byte change invalidates the digest, reopens the change's review requirement, and demands a fresh review — a high-thinking, read-only pass over the whole repository by a frontier-model agent with a thirty-minute ceiling, plus the reviewer-selection and tool-audit machinery around it.

Fixing a typo in the proposal therefore costs a full planning review. During iterative refinement, which is the normal path, that is the most repeated large expense in the harness, and most of the edits that trigger it change nothing the reviewer approved.

This is also the one integration that lets a model's answer decide whether a correctness gate runs. That is why it ships off by default, is scoped to the prose that cannot change what is built, is capped, is recorded honestly, and is measured in shadow mode before it acts.

## What Changes

- Before dispatching a reviewer for a changed artifact set, decide whether the previous approval can be carried forward. Eligibility is decided by code first: the previous review approved; a retained copy of the approved artifacts exists; the only artifacts that differ are the proposal and the design; fewer than three consecutive carry-forwards have already happened; and no extra review instructions were given. If any condition fails, a full review runs and nothing is sent for judgment.
- For an eligible edit, ask a typed judgment how much the change alters what is being proposed, and whether it changes requirements, scenarios, tasks, or scopes, or contradicts what the approval relied on.
- Carry the approval forward only when the edit is judged immaterial with high confidence and every change question is confidently no. Anything else runs the full review.
- Never carry forward a revise, never cross a specification or task-list change, and never carry forward more than three consecutive edits, because accumulated immaterial edits are materially different from one.
- Record the carry-forward honestly in the review artifact: it names the basis review and its digest, the running count, and the judgment's answers and decision record, while the verdict and reviewing model remain those of the real review that approved.
- Retain the approved prose and per-file digests when triage is enabled, so a later edit can be compared against what was actually approved.
- Ship disabled by default behind its own flag, and run first in shadow mode, always reviewing while recording what would have been skipped and whether the review would have agreed.

## Capabilities

### New Capabilities

- `judgment-review-triage`: When a planning review's approval may be carried forward across an edit that only changes proposal or design prose without repeating the full review, the conditions that keep this safe, and how a carried-forward review is recorded.

### Modified Capabilities

None.

## Impact

- **Review controller:** an optional triage step before reviewer dispatch, and retention of the approved artifacts after an approval when triage is enabled.
- **Review artifact:** optional carry-forward marks and an evidence section, rendered and parsed; earlier artifacts remain valid, and every lifecycle consumer sees an ordinary approval of the current digest.
- **Review phase:** builds the triage dependencies when the flag is set and tells the user when a review was carried forward.
- **Cost:** about $0.0002 per eligible edit, against a thirty-minute high-thinking review.
- **Egress:** unified diffs of the proposal and the design and the previous review's recommendations. Documented in the security documentation.
- **Risk:** the highest of the rollout, and the reason for the flag, the cap, the prose-only scope, the provenance, and shadow mode. The original proposal's own open question — whether the risk is worth it — is answered by shadow data, not by this plan.
- **Rollout gate:** flag-gated; proposal and design prose only; at most three consecutive carry-forwards; and shadow evidence, across a meaningful number of real edits, that judged-immaterial edits almost never change a review's verdict.
- **Ordering:** depends on `judgment-layer`. Independently revertable.
- **Coordination:** the review controller, the review artifact, and the review phase have edits in flight at the time of writing.
