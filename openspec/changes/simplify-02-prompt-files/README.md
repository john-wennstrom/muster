# simplify-02-prompt-files

Part 2 of 7 in the harness simplification series (see `docs/simplification.md`). Moves every agent prompt and every Jev question into template files with declared variables, behind one strict renderer. Pure refactor: rendered text is byte-identical to today's, proved by golden files captured before anything moves. Depends on simplify-01-retire-legacy-surface.
