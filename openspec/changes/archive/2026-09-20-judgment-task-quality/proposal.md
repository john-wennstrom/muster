## Why

A task list is validated structurally: every executable checkbox needs an adjacent metadata block, identifiers must be well formed, references must resolve, and the dependency graph must be acyclic. Nothing checks whether the tasks are any good. A task whose verification command would pass even if the task were implemented wrongly, whose declared write scopes do not cover the files it must change, that bundles two commits' worth of work, or that depends on work it does not list is structurally perfect — and fails hours later inside a builder session with an eight-hour ceiling, followed by a repair cycle, and sometimes a design conflict and a re-plan.

Each of those defects is visible in the text of the task list and the specifications it implements. A cheap typed judgment over the whole list at plan time can flag the likely ones while they are still a sentence to fix, before any builder has spent anything.

## What Changes

- After synthesis returns a task list that parses and validates, assess all tasks together in one judgment call over the tasks, the requirements, and the scenarios: whether each task's verification would fail if the task were implemented incorrectly, whether its write scopes cover the files it needs, whether it is one coherent unit, whether it depends on unlisted work, and how large it is; and whether the tasks together cover every requirement.
- Turn concerns that cross their thresholds into advisory findings whose text comes from fixed templates naming the task and the judged probability. Findings are never rewritten into the artifacts, never set a verdict, and never write the review artifact.
- Deliver findings where people already look: the planning outcome shows them immediately, and the reviewer's prompt includes those that are still current, marked as unverified, so the reviewer arrives knowing where to look and remains the only author of the review.
- Bind findings to a digest of the task definitions that ignores completion state, so a finding is not shown for a task list that has since changed and survives checkbox updates.
- Record each task's eventual outcome against whether it was flagged, so the correlation between findings and real build problems is measurable.
- Never let the assessment change what planning writes: unavailable, disabled, or invalid input leaves planning exactly as it is today.

## Capabilities

### New Capabilities

- `judgment-task-quality`: How a synthesized task list is assessed for semantic quality at plan time and how the resulting advisory findings reach the user and the reviewer without altering any artifact or gate.

### Modified Capabilities

None.

## Impact

- **Planning phase:** one judgment call while the synthesized artifacts are written, over content already in memory; the written artifacts are unchanged. The planning outcome may list findings.
- **Review phase:** the reviewer's prompt may include current, unverified plan-time findings.
- **Implementation phase:** each task's outcome is reconciled against the plan-time record.
- **Cost:** about $0.0005 for twelve tasks, against a builder run plus a repair cycle and sometimes a re-plan.
- **Egress:** the change summary excerpt, requirement and scenario text, and every task's description, dependencies, scopes, and verification commands. Documented in the security documentation.
- **Rollout gate:** findings correlate with real build failures, measured from the reconciled outcomes.
- **Ordering:** depends on `judgment-layer`. Independently revertable.
- **Coordination:** the planning and review phase modules have edits in flight at the time of writing.
