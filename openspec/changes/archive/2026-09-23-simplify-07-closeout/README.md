# simplify-07-closeout

Part 7 of 7 in the harness simplification series (see `docs/simplification.md`). Locks the result in: empties the temporary allowlists, adds size and session budgets as tests so the code cannot quietly regrow, checks that the documentation names every command and every judgment decision, and refreshes the README, flow diagrams, roadmap and end-to-end test job. Depends on simplify-06-lean-execution.

## Manual acceptance (not a task)

After the series lands, run the end-to-end chain test in `docs/e2e-chain-test.md` against the sibling `minding` repository twice: once with judgment off (expect the medium lane, seven-ish sessions as before but fewer than the pre-series count) and once with `MUSTER_JEV=1` and a key (expect the small lane for the single-function job, at most three agent sessions, no planning reviewer). Compare `/change status` usage between the two runs and record the figures in `docs/simplification.md`. This needs model credentials and a Jev key, so it is a human step.
