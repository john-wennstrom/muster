## Why

The `/change` surface is split across two directories whose boundary has no stated rule and which import each other.

`src/runtime/command.ts` imports phase option types from `src/muster/review.ts` and `src/muster/verify.ts`, while all nine files in `src/muster/` import from `src/runtime/`. The two directories form an import cycle.

The de facto placement rule is "phase logic used by two commands lives in `src/runtime/`, phase logic used by one command lives in `src/muster/`". That is why planning logic (shared by `propose` and `refine`) and implementation logic (shared by `implement` and `resume`) sit in `src/runtime/`, while review, verification, and finish logic sit inside their own command files — `src/muster/verify.ts` is 262 lines, of which roughly 230 are phase logic and roughly 30 are the handler. The documented rule ("exactly one file per command in `src/muster/`") is therefore true only by accident: a command file is a handler when its phase is shared and a handler plus a phase runner when it is not.

Consequences: a contributor cannot predict where a phase lives; adding a second consumer to a phase implies moving the file; and the cycle means the two directories cannot be reasoned about, tested, or extracted independently.

## What Changes

- Consolidate the `/change` surface into one directory with two explicit layers: thin per-action handlers and phase runners, with every phase runner in the phase layer regardless of how many actions use it.
- Move the review, verification, and finish phase logic out of their command files into the phase layer, so every command file is a handler and nothing else.
- Move each phase's options type into the phase layer so the shared command types no longer import from command files, removing the import cycle.
- Update the extension entry point, the dependency assembly, tests, scripts, and repository documentation to the new paths.

This is a move-and-rename change. No behavior, command grammar, outcome shape, persisted format, or public extension entry point changes.

## Capabilities

### New Capabilities

- `change-module-layout`: The layering contract for the `/change` surface — where handlers live, where phase runners live, and the permitted direction of dependencies between them.

### Modified Capabilities

None.

## Impact

- **Source layout:** `src/muster/` and `src/runtime/` are replaced by a single `/change` surface directory containing a handler layer, a phase layer, and the dispatcher, registration, outcome, branding, and assembly modules.
- **Import graph:** the handler-to-phase dependency becomes one-directional; the existing cycle is removed and can be asserted against.
- **Extension entry point:** the registered extension module keeps its current external path and export signature so the packaged extension manifest does not change.
- **Tests:** test files under `tests/` that import the moved modules are updated; no test assertions change.
- **Documentation:** the repository agent guidelines, the `/change` wiring instructions, and any roadmap or design references to the old paths are updated in the same change, since stale path references in those files have previously caused real wiring defects.
- **Prerequisite:** this change assumes the handler contract, command metadata table, and branding module from `unify-change-handler-runtime` are already in place; moving files before the handlers are uniform would relocate code that is about to be rewritten.
