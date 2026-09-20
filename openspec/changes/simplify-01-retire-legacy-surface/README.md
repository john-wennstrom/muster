# simplify-01-retire-legacy-surface

Part 1 of 7 in the harness simplification series (see `docs/simplification.md`). Removes the old Fusion Harness extension and its commands, moves the runtime code the `/change` pipeline still needs into `src/`, and collapses four layers of child-process spawning into one. Must land first: every later change assumes one command surface, one spawn path and no `extensions/` directory.

Series order: 01 retire-legacy-surface, 02 prompt-files, 03 judgment-core, 04 triage-lanes, 05 structured-planning, 06 lean-execution, 07 closeout.
