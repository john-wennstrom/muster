# muster — agent guidelines

OpenSpec-driven multi-agent development workflows for Pi. Primary user-facing surface is the `/change` command family (explore/propose/refine/review/implement/verify/finish/status/resume).

## Architecture: one system

- `src/controller`, `src/execution`, `src/persistence`, `src/telemetry`, `src/review`, `src/openspec`, `src/agents` — the architecture backing `/change`, the only registered command. Heavily unit-tested as isolated libraries; production wiring into real I/O is assembled in `src/change/dependencies.ts` (`createProductionChangeCommandDependencies`), one phase at a time. Check `docs/roadmap.md` for which `/change` handlers currently have a production implementation vs. "not available in this build" — passing unit tests for a controller/library do **not** imply its `/change` handler is wired.
- `src/change/` is the whole `/change` surface, in two layers. `src/change/handlers/` has exactly one thin module per subcommand (`explore.ts`, `propose.ts`, `refine.ts`, `review.ts`, `implement.ts`, `resume.ts`, `verify.ts`, `finish.ts`, `status.ts`), each built with `defineChangeHandler(action, run)` and containing only argument interpretation plus one phase call. `src/change/phases/` has every phase runner (`planning`, `implementation`, `review`, `verification`, `finish`, `status`, `exploration`) regardless of how many subcommands use it. Shared machinery sits at the surface root: `change-command.ts` (parse/dispatch/render/classify/register), `commands.ts` (the per-action metadata table), `handler.ts`, `command.ts`, `branding.ts`, `transcript.ts`, `models.ts`, `snapshot.ts`, `agent-progress.ts`, `dependencies.ts`. Dependencies run handlers → phases → libraries and never back; `tests/muster/module-layout.test.ts` enforces it. `src/muster/index.ts` is the Pi extension entry point named in `package.json`; it registers `/change` and the five flags the pipeline reads (`fh-config`, `architect`, `builder`, `planning-max-tokens`, `planning-max-cost`).
- Child agents are spawned as real OS subprocesses (`pi --mode json -p`), not through the live in-process extension context. Wiring a new production handler for `/change` therefore does not need the extension `ctx` — only `cwd`, a model string, and a scratch session dir (see `src/agents/spawn.ts::runAgent`, the one entry point that starts a child in read or write mode).
- Model selection goes through `resolveModelStack`/`roleModel` in `src/change/models.ts`: `MUSTER_<ROLE>_MODEL` env override > `--fh-config` YAML slot > CLI flag > one declared fallback per role. Never add a competing default in a phase.
- Return a `CommandOutcome` and let the dispatcher emit it: it posts a durable transcript panel tagged `MUSTER_CUSTOM_TYPE` with structured details, falling back to `ui.notify` (a transient toast) only when the host has no renderer.

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

`bun run test` and `bun run ci:test` both run the whole suite. On Windows dev machines, ~20 pre-existing failures are expected (symlink `EPERM` without dev mode/admin, and `/` vs `\` path-separator fixture assertions) — not regressions; compare failure counts before/after your change rather than expecting 0 failures.

## Conventions

- OpenSpec is the source of truth for change proposals/specs/design/tasks under `openspec/changes/<change>/`; see the `openspec-*` skills for the explore/propose/apply/archive workflow. Every checkbox item in a change's `tasks.md` requires an immediately-adjacent fenced ` ```yaml harness-task ` metadata block or parsing throws `TASK_DOCUMENT_INVALID`.
- Security model (brokered/audited host commands vs. direct standard tools) is documented in `docs/security.md` — read it before touching `src/tools/`, `src/agents/spawn.ts`, or `src/execution/`.
- Prefer linking to `docs/testing.md`, `docs/security.md`, `docs/roadmap.md` over duplicating their content in new docs or comments.
