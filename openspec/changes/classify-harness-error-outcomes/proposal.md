## Why

When a `/change` invocation throws, the dispatcher converts the error into a user-facing outcome by testing the error's code against five inline sets of string literals and then selecting a blocker kind through a five-level nested conditional. That mapping is not connected to the declared error-code union, and it has drifted from it in both directions.

- Three codes the mapping tests for — the ones that would classify a failure as a model-availability problem — are not members of the declared error-code union at all. No code in the repository can produce them, so the entire model-unavailable classification is unreachable, and a genuine model-availability failure is reported as a generic failure with no blocker.
- Codes that exist and are thrown are absent from the mapping, including lifecycle-transition, task-document, task-outcome, scheduler, worktree, and version-control failures. Each is reported as an unclassified failure with no blocker detail and no next step.
- The planning phase throws the exploration phase's failure code for planning agent failures, so a planning failure is attributed to exploration in the outcome, in persisted records, and in any downstream filtering by code.
- The fallback code used when a non-harness error escapes is a string literal that is not a member of the union, so it cannot be matched by anything that consumes codes.

The user-visible effect is that some real failures produce no actionable guidance, and the classification cannot be audited because nothing forces it to stay aligned with the codes that exist.

## What Changes

- Replace the inline sets and nested conditional with one exhaustive declaration mapping every declared error code to its user-facing classification, so a newly declared code cannot be added without declaring how it is presented.
- Remove the unreachable classifications for codes that do not exist, and either declare those codes or delete the branches that test for them.
- Classify the currently unclassified codes that are thrown in production paths, so their failures carry a blocker and a next step.
- Introduce a distinct planning-agent failure code and use it for planning agent failures instead of the exploration code.
- Give the non-harness escape path a declared code rather than an undeclared literal.

## Capabilities

### New Capabilities

- `command-failure-classification`: How a raised error becomes a user-facing `/change` outcome — the exhaustive code-to-classification contract, the guarantees it provides, and the treatment of unrecognized failures.

### Modified Capabilities

None.

## Impact

- **Error codes:** the declared code union gains a planning-agent failure code and a code for unrecognized failures; codes referenced by the mapping but never declared are removed or declared.
- **Classification:** the dispatcher's error-to-outcome conversion is driven by one declaration instead of inline literals and nested conditionals.
- **Planning phase:** planning agent failures are reported and persisted under their own code.
- **Outcomes:** failures that previously reported no blocker now report one where a classification exists; statuses, blocker kinds, and the outcome shape are unchanged.
- **Tests:** a test asserts the declaration covers every declared code; existing outcome tests are extended to cover newly classified codes.
- **Compatibility:** consumers that match on the exploration failure code for planning failures will need to match the new planning code; this is an internal code, not part of the command grammar.
