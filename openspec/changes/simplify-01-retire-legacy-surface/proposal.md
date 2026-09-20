## Why

Muster runs two parallel systems. The `/change` pipeline in `src/` is the supported surface, but the original Fusion Harness extension (about 5,500 lines under `extensions/`) is registered unconditionally beside it and still owns commands (`/fh-*`, `/refine`, `/implement`, `/ship`, `/os-status`, `/init`), the flag registrations, and the prompt library that the pipeline never uses. The new pipeline is not independent of it: 25 import sites under `src/` reach into `extensions/fusion-harness/modules/` for the model stack, the run record, the child runtime resolution, the terminal widgets and the collaboration graph.

Spawning a model child is spread across four layers that each wrap the next: the extension's `runChild`, the brokered child runner, a module named `legacy-adapter` that is in fact the production entry point (its name is a leftover), and a role runner. A fifth path, the scope planner, exists only for the retired commands. Every child-related change has to be made in several places and reasoned about across all of them.

Four modules under `src/` have no production caller at all and exist only for their tests: the capability model router, the state precedence resolver, the manual-checkpoint UI, and the telemetry report generator. Dead code that looks wired misleads readers about what the system does.

None of this is protected: nothing stops new unwired modules from accumulating again.

## What Changes

- **BREAKING** Remove `/refine`, `/implement`, `/ship`, `/os-status`, `/init` and every `/fh-*` command. `/change` becomes the only registered command family. There are no aliases and no migration stubs.
- Delete the `extensions/` directory, its tests, its import manifest and verification script, the root `prompts/duckdb/` demo prompts, and the package scripts and files entries that refer to it.
- Move what the pipeline still needs into `src/agents/` (model stack, run record, child runtime resolution) and `src/change/ui/` (the live agent columns).
- Replace the four spawn layers and the scope planner with a single child-agent entry point offering a read-only mode and a brokered writer mode.
- Register the five flags the pipeline reads (`fh-config`, `architect`, `builder`, `planning-max-tokens`, `planning-max-cost`) from the entry point, keeping their names.
- Delete the four unwired modules and their tests.
- Add a guard test that fails when any module under `src/` has no production importer and is not a declared entry point, with a temporary allowlist that later changes in the series shrink to empty.

## Capabilities

### New Capabilities

- `agent-runtime`: one child-agent entry point, and the rule that the source tree does not depend on any retired extension code.
- `command-surface`: `/change` is the only command family, retired commands are removed rather than aliased, and the flags the pipeline reads are registered by the entry point.
- `source-hygiene`: every source module has a production importer or is a declared entry point, enforced by a test.

### Modified Capabilities

- `change-module-layout`: the stable extension entry point keeps its path and registration signature but registers only `/change` and its flags.

## Impact

- **Removed:** `extensions/fusion-harness/**`, `src/agents/legacy-adapter.ts`, the extension-side child runner, `src/agents/model-router.ts`, `src/controller/state-precedence.ts`, `src/change/manual-ui.ts`, `src/telemetry/report.ts`, and their tests (about 6,500 lines of source and tests).
- **Moved:** model stack, run record, child runtime, and terminal widgets into `src/`.
- **Package:** `package.json` drops the `extensions` files entry and the `test:fusion-harness` and `verify:import` scripts. `scripts/ci/validate.ts` and the CI workflow stop referring to them.
- **Docs:** README's legacy migration section becomes a short retired-commands note, and `AGENTS.md` loses its two-systems warning.
- **Users:** anyone still typing a retired command gets Pi's unknown-command response. Flag names do not change, so existing model-stack YAML and launch lines keep working.
- **Compatibility:** persisted run records are unaffected by this change.
