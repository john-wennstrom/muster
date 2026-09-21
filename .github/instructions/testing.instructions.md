---
description: "Use when running or writing tests, interpreting test failures, or validating changes before considering a task done."
applyTo: "tests/**,src/**"
---

# Testing

- `bun run test` and `bun run ci:test` run the full unit/integration suite (`bun test`).
- Also run `bun run typecheck`, `bun run test:extension-smoke`, `bun run test:git-worktree`, `bun run test:host-runner` for changes touching the extension entry point, Git/worktree, or the audited host runner respectively.
- On Windows dev machines, ~20 pre-existing failures are expected and are not regressions: symlink `EPERM` (no dev mode/admin) and `/` vs `\` path-separator assertions in fixtures (git adapter, worktree manager, tool authorization, adversarial broker/host-runner, recovery fault matrix). Compare the failing-test list/count before and after your change instead of expecting a fully green run.
- `bun run docs:check` validates documentation links, command examples, and security wording — run it after editing README.md/docs/**.
- `bun run ci:validate` parses `.github/workflows/cross-platform.yml` and checks the OS matrix/runtime pins/frozen install/required scripts — run it after editing CI workflow files or `package.json` scripts.
- Task metadata fixtures: every checkbox in an OpenSpec `tasks.md` needs an immediately-adjacent fenced ` ```yaml harness-task ` block or `parseTaskDocument` throws `TASK_DOCUMENT_INVALID`.
