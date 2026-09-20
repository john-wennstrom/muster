# simplify-06-lean-execution

Part 6 of 7 in the harness simplification series (see `docs/simplification.md`). Cuts the per-task cost of implementation: merges chained same-scope tasks, lets Jev skip a task review under strict guards, chooses builder and reviewer thinking per task, records failures and lets a Jev decision retry, escalate or stop, reuses verification evidence, and splits the 452-line implementation phase. Depends on simplify-05-structured-planning.
