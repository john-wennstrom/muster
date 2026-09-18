# muster — agent guidelines

OpenSpec-driven multi-agent development workflows for Pi. Primary user-facing surface is the `/change` command family (explore/propose/refine/review/implement/verify/finish/status/resume).

## Architecture: two parallel systems — do not confuse them

- `extensions/fusion-harness/` — **OLD but LIVE**. Registered unconditionally in `src/muster/index.ts`. Real, working commands today: `/fh*`, `/refine`, `/implement`, `/ship`, `/os-status`, `/init`.
- `src/controller`, `src/execution`, `src/persistence`, `src/telemetry`, `src/review`, `src/openspec`, `src/agents` — **NEW** architecture backing `/change`. Heavily unit-tested as isolated libraries; production wiring into real I/O is assembled in `src/runtime/dependencies.ts` (`createProductionChangeCommandDependencies`), one phase at a time. Check `docs/roadmap.md` for which `/change` handlers currently have a production implementation vs. "not available in this build" — passing unit tests for a controller/library do **not** imply its `/change` handler is wired.
- `src/muster/` contains exactly one file per `/change` subcommand, named after the command (`explore.ts`, `propose.ts`, `refine.ts`, `review.ts`, `implement.ts`, `resume.ts`, `verify.ts`, `finish.ts`, `status.ts`), plus `index.ts` (the Pi extension entry point registered in `package.json`). Each command file exports a `createXHandler(cwd, options)` factory wired into `handlers` by `src/runtime/dependencies.ts`. Everything shared across commands (dispatcher, run-context/outcome helpers, agent progress UI, manual-checkpoint UI, snapshot/usage loading, model-stack resolution, dependency assembly) lives in `src/runtime/`, not `src/muster/`.
- Child agents are spawned as real OS subprocesses (`pi --mode json -p`), not through the live in-process extension context. Wiring a new production handler for `/change` therefore does not need the extension `ctx` — only `cwd`, a model string, and a scratch session dir (see `src/agents/legacy-adapter.ts::runLegacyReadOnlyChild`, the reusable "spawn one read-only agent" primitive).
- Model selection for new handlers must follow the same precedence as fusion-harness (`MUSTER_EXPLORE_MODEL`-style env override > `--fh-config` YAML slot > CLI flag > hardcoded default) — do not hardcode a default model.
- Deliver phase output via `ChangeCommandContext.sendMessage` (persistent transcript panel), not `ui.notify` (transient toast) — `notify` is fine only for short status/errors.

## Build, test, and validate

Run from repo root; CI pins Bun `1.4.0` / Node 22 (see `docs/testing.md` for the full authoritative list):

```
bun install --frozen-lockfile
bun run typecheck
bun run ci:test           # full unit/integration suite (bun test)
bun run test:extension-smoke
bun run test:git-worktree
bun run test:host-runner
bun run ci:validate        # validates .github/workflows/cross-platform.yml contract
bun run docs:check         # validates doc links/command examples/security wording
```

`bun run test` and `bun run test:fusion-harness` only run `extensions/fusion-harness/tests` — use `bun run ci:test` for the whole suite. On Windows dev machines, ~20 pre-existing failures are expected (symlink `EPERM` without dev mode/admin, and `/` vs `\` path-separator fixture assertions) — not regressions; compare failure counts before/after your change rather than expecting 0 failures.

## Conventions

- OpenSpec is the source of truth for change proposals/specs/design/tasks under `openspec/changes/<change>/`; see the `openspec-*` skills for the explore/propose/apply/archive workflow. Every checkbox item in a change's `tasks.md` requires an immediately-adjacent fenced ` ```yaml harness-task ` metadata block or parsing throws `TASK_DOCUMENT_INVALID`.
- Security model (brokered/audited host commands vs. direct standard tools) is documented in `docs/security.md` — read it before touching `src/tools/`, `src/agents/child-runner.ts`, or `src/execution/`.
- Prefer linking to `docs/testing.md`, `docs/security.md`, `docs/roadmap.md` over duplicating their content in new docs or comments.
