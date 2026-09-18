## Why

Muster advertises a complete `/change` lifecycle, but the default production registration only wires exploration and status. The remaining commands either stop at a missing-handler fallback or depend on test-only injection, so the shipped command surface cannot carry a real change through planning, review, implementation, verification, recovery, and finish.

## What Changes

- Add production handlers for `propose`, `refine`, `review`, `implement`, `verify`, `finish`, and `resume`, assembled from the existing OpenSpec, Git, persistence, broker, child-runner, controller, and UI boundaries.
- Introduce one invocation-scoped command context containing repository and planning locations, validated change identity, selected worktree, run identity, resolved models, cancellation, and persistent output.
- Validate explicit and remembered change names and resolved paths before any read or active-change write, including traversal, absolute-path, malformed-slug, missing-change, and canonical-name collision cases.
- Make exploration independent of active-change snapshot health and keep status free of incidental active-change mutations.
- Replace generic availability messages with prerequisite diagnostics that identify missing artifacts, stale evidence, unavailable models, and pending checkpoint IDs.
- Add default-registration acceptance tests that invoke every advertised action without replacing production handlers and require each invocation to persist or report a terminal success, blocked, cancelled, or failure outcome.

## Capabilities

### New Capabilities

- `production-command-assembly`: Production assembly, invocation context, validation, dispatch, diagnostics, and acceptance behavior for the advertised `/change` lifecycle.

### Modified Capabilities

None. The repository has no archived capability specifications; this focused capability refines behavior originally described by the still-open `build-openspec-multi-agent-harness` change.

## Impact

- **Runtime and dispatcher:** `src/muster/production-runtime.ts`, `src/muster/change-command.ts`, and `src/muster/index.ts` gain invocation-scoped dependency construction and complete handler registration.
- **Controllers and adapters:** existing planning, review, implementation, recovery, verification, finish, OpenSpec, Git, broker, child, persistence, routing, and host-runner interfaces are assembled behind production dependencies; their quality and permission gates remain authoritative.
- **Command behavior:** read-only commands stop mutating active-change state, invalid identifiers fail before filesystem access, and exploration no longer depends on loading a remembered change.
- **Tests:** command and production-runtime tests exercise the real default registration path and deterministic fakes only at external process/model boundaries.
- **Compatibility:** legacy commands remain available during migration, but they do not substitute for production `/change` handlers.
