---
description: "Use when wiring, debugging, or extending a /change command production handler (explore/propose/refine/review/implement/verify/finish/status/resume) or files under src/muster/*.ts, src/runtime/dependencies.ts, src/runtime/change-command.ts, src/controller/**."
---

# `/change` production wiring

- `src/muster/` holds exactly one file per command (`explore.ts`, `propose.ts`, `refine.ts`, `review.ts`, `implement.ts`, `resume.ts`, `verify.ts`, `finish.ts`, `status.ts`), each exporting a `createXHandler(cwd, options)` factory. `src/runtime/dependencies.ts` (`createProductionChangeCommandDependencies`) wires them together — check `docs/roadmap.md` first for which handlers already have a production implementation; passing controller/library unit tests do not mean the handler is wired to real I/O.
- Reuse `src/agents/legacy-adapter.ts::runLegacyReadOnlyChild` (built on `src/agents/child-runner.ts::runBrokeredChild`) as the "spawn one read-only agent" primitive; it does not need the live extension `ctx`, only `cwd`, a model, and a scratch session dir.
- Resolve the model the same way `resolveExploreModel()` does: `MUSTER_EXPLORE_MODEL`-style env override > `--fh-config <path>` YAML slot (via `loadModelStack`) > CLI flag > hardcoded default. Never hardcode a specific model as the sole default — some users only authenticate GitHub Copilot models, not Anthropic.
- Send phase deliverables via `context.sendMessage?.(...)` (falls back to `context.ui.notify(...)` only when `sendMessage` isn't provided, e.g. in tests). `ui.notify` is a transient toast and will not show multi-paragraph output.
- `parseChangeCommand` special-cases `explore` to treat its entire remainder as a free-text prompt (no positional `changeName`) — follow the same care for other actions that take free-text arguments so a stray word isn't persisted as the active change.
- After wiring a new handler, **smoke-test it live** (real `pi` child spawn) in addition to unit tests — several real bugs (stale extension paths, hardcoded models, wrong notify vs. sendMessage) only surface when a real child process actually runs; `bun test` never spawns one.
- Re-run `bun run ci:test` after each wiring slice and compare the pass/fail count against the pre-existing Windows-only baseline (symlink `EPERM`, path-separator fixtures) rather than expecting zero failures.
