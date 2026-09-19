## Why

Every task in a change's task graph gets a full code review by a frontier-model agent in a fresh session. The review prompt already assembles exactly the right inputs — the task contract, the diff, the test evidence, the authorized scopes, and the test-first evidence — and hands all of it to the reviewer with a general instruction to report defects in five areas: contract, diff, tests, scopes, and test-first discipline. The reviewer must therefore discover where to look, on every task, from scratch.

A cheap set of typed judgments over those same inputs can say where attention is most likely to pay off: whether the diff stays within its scopes, whether it implements what the contract describes, whether the tests exercise the scenarios, whether the test-first evidence is coherent, whether the diff adds a stub or a hard-coded value, and whether it touches a security boundary. Passed to the reviewer as a short advisory hint — the same pattern that reduced wrong skill loads for an agent choosing among many skills — this points the reviewer without deciding anything.

## What Changes

- Ask a fixed set of typed questions over the review inputs the harness already assembles, in one call before the reviewer runs.
- Turn answers that cross their thresholds into a short advisory focus list, drawn only from a fixed catalogue of phrases, capped at four items in a fixed priority order, and add it to the reviewer's prompt with an instruction to disregard it wherever the diff does not support it.
- Leave the prompt byte-for-byte unchanged when no answer crosses a threshold, when judgment is unavailable, and in shadow mode.
- Change no gate. The reviewer still runs for every task, still returns the verdict, is still audited for tool use, and remains the only source of the approval. Judgment never skips, replaces, or overrides a review.
- Record the review's outcome against the focus that was, or would have been, given, so finding counts can be compared between focused and unfocused reviews.
- Not included: skipping the reviewer for trivially safe tasks. That variant touches a correctness gate and is a separate change with its own flag and gates.

## Capabilities

### New Capabilities

- `judgment-task-review-focus`: How a task code reviewer is pointed at the parts of a change most likely to matter — an advisory focus list derived from typed judgments over the review inputs the harness already assembles — without changing who decides the verdict or any gate.

### Modified Capabilities

None.

## Impact

- **Task review step:** one judgment call before the reviewer runs, and an optional advisory block in the reviewer's prompt. The reviewer's contract, tools, timeout, and validation are unchanged.
- **Cost:** about $0.0003 per task, against one reviewer agent per task. Reviewer runs may shorten, which the recorded outcomes can show.
- **Egress:** the task contract, an excerpt of the diff with the complete list of changed paths, the test output, the scopes, and the test-first evidence. The test output is the field most likely to carry incidental secrets, so redaction matters here. Documented in the security documentation.
- **Rollout gate:** reviewer finding counts hold or improve. Shadow mode first supplies the unfocused baseline; enforce is then compared against it.
- **Ordering:** depends on `judgment-layer`. Independently revertable: reverting removes one call and one optional prompt block.
