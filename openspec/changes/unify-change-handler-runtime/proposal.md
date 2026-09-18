## Why

The nine `/change` subcommand handlers were wired one slice at a time, and each slice invented its own shape. The result is nine structurally different handlers that disagree about details users can observe:

- `verify` and `finish` take `_context` and therefore never forward `onAgentStart`, so those two phases render no live agent progress while every other phase does.
- `ChangeCommandContext.actor` is read by `resume` but never populated by `registerChangeCommand`, so every manual checkpoint confirmation is attributed to the literal `local-user`.
- The `muster-change` transcript label is a private literal in the dispatcher with no registered renderer and no structured `details` payload, while the legacy Fusion surface exports a shared `CUSTOM_TYPE`, registers a renderer, and attaches typed details. `/change` output therefore renders in a bare fallback box and carries no machine-readable outcome.
- `agent-progress.ts` re-derives the same `muster-change` prefix as a widget key by hand instead of importing it.
- Seven of nine handlers use a `command.changeName!` non-null assertion because the handler signature cannot express "the dispatcher already guaranteed a change name".
- `MUSTER_EXPLORE_MODEL` is the only environment model override in the product; `propose`, `refine`, `review`, `implement`, and `verify` consult no environment variable at all, contradicting the documented precedence rule.
- Snapshot loading, prompt joining, signal merging, observer forwarding, and runner-override selection are copy-pasted with small variations across handlers, and helpers such as `rawCliFlag`, filesystem existence probes, path-containment checks, record readers, tasks.md loading, and run-store opening each exist in two or three near-identical copies.

Every new phase therefore costs more than it should and silently acquires a slightly different behavior contract.

## What Changes

- Extract shared helpers that are currently duplicated (CLI flag reading, path existence, path containment, record reading, validated task loading, source-digest reading, run-store opening) into single owners, with no behavior change.
- Introduce one exported branding module owning the `muster-change` custom type, widget-key derivation, and a typed transcript details payload; register a message renderer so `/change` output has the same presentation contract as the legacy Fusion surface.
- Declare per-action command metadata (argument shape, change requirement, lifecycle gating, statefulness) in one table and drive the dispatcher, usage strings, subcommand list, and run-identity selection from it instead of from inline special cases spread across the dispatcher and the dependency assembly.
- Introduce one handler definition contract so every subcommand handler receives one normalized request and returns one partial outcome, eliminating the per-handler assertions, prompt joins, signal merges, observer forwarding, and snapshot loading.
- Unify model resolution so every role and every phase honours the same documented precedence, including an environment override.
- Split the runtime options bag into configuration and test overrides, give each phase its own options type, and stop constructing per-invocation state that no handler reads.

No user-visible command behavior is removed. Two observable defects are corrected: `verify`/`finish` gain agent progress, and manual checkpoint confirmations record the real actor.

## Capabilities

### New Capabilities

- `change-command-runtime`: The uniform runtime contract shared by every `/change` subcommand — command metadata, handler request/outcome shape, transcript presentation identity, model resolution precedence, and the configuration/override seam.

### Modified Capabilities

None. The repository has no archived capability specifications. This capability refines runtime behavior first described by the still-open `production-command-assembly` change.

## Impact

- **Handlers:** all nine files under `src/muster/` are rewritten against the new handler contract; each shrinks to argument interpretation plus one phase call.
- **Runtime:** `src/runtime/change-command.ts`, `command.ts`, `dependencies.ts`, `agent-progress.ts`, `planning.ts`, `implementation.ts`, and `snapshot.ts` adopt the shared helpers, metadata table, branding module, and split options types.
- **Shared code:** new single-owner helpers under `src/shared/`, `src/execution/`, and `src/persistence/` replace duplicated copies.
- **Presentation:** `/change` transcript messages gain a registered renderer and typed details; the existing plain-text rendering remains the renderer's fallback so non-interactive hosts are unaffected.
- **Tests:** existing handler and dispatcher tests continue to exercise the real default registration; new tests cover the metadata table, the handler contract, actor propagation, agent-progress coverage for `verify`/`finish`, and model-precedence parity across roles.
- **Compatibility:** the `/change` command grammar, outcome statuses, blocker kinds, and legacy Fusion commands are unchanged.
- **Out of scope:** the `src/muster/` and `src/runtime/` directory merge, the error-code classification table, and splitting the two oversized modules are tracked as separate changes and must not be attempted here.
