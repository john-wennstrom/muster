# simplify-03-judgment-core

Part 3 of 7 in the harness simplification series (see `docs/simplification.md`). Restructures the judgment layer (one module per decision, one call-site helper, one generic summary), replaces recorded fixtures with a scripted client, makes enforce the default mode once a key is set, removes the per-decision enabling flags, and deletes the unwired capsule-ranking decision. Depends on simplify-02-prompt-files.
