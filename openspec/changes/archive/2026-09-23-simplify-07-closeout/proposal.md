## Why

The six earlier changes remove code and cut sessions, but nothing stops either from creeping back. Temporary allowlists were added along the way (unwired modules, prompt exclusions) and must reach empty. The modules that were too large were split by hand, and only a test can keep them from growing again. The headline claim of the series, that a small change costs a few sessions instead of seven, has no regression test. And the documentation (README, command flow diagrams, security table, the end-to-end job) describes the old pipeline.

## What Changes

- Assert the temporary allowlists (unwired modules, prompt exclusions) are empty and delete them.
- Add a source size budget test: no module under `src/` exceeds 500 lines. Split any that still do.
- Add a test-size guard: no test file exceeds 600 lines without a header comment justifying it. Split the ones that do.
- Add agent-session budget tests over the end-to-end lifecycle with stubbed agents: a small-lane one-task change uses at most three agent sessions, and a medium-lane one-task change at most four.
- Extend the documentation check: the security call-site table names every catalogued decision, and the command flow document names every `/change` action and every decision.
- Refresh the README, `AGENTS.md`, roadmap, testing guide, command flow diagrams, simplification analysis and the end-to-end chain test job for the new pipeline.

## Capabilities

### New Capabilities

- `harness-budgets`: empty allowlists, source and test size budgets, and agent-session budgets by lane.
- `documentation-currency`: documentation that names every action and every decision, checked by the documentation check.

### Modified Capabilities

None.

## Impact

- **New:** `tests/layering/size-budget.test.ts`, session-budget scenarios in `tests/e2e/`, additions to `scripts/docs/check.ts`.
- **Removed:** the two temporary allowlist files.
- **Changed:** any source or test file over budget is split; documentation files listed above.
- **Behavior:** none at runtime.
- **Prerequisite:** simplify-06-lean-execution, so every module the series deletes or splits is already gone.
