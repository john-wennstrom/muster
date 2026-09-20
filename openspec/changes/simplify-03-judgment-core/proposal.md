## Why

The judgment layer is about 3,500 lines across 17 modules, and most of the size is structure, not behavior.

- `gates.ts` (1,275 lines) holds ten decisions: their input types, state builders, gates, presenters and confidence bands, in one file. `questions.ts` (779 lines, mostly wording that the previous change moves out) holds the identifiers for all of them.
- Every call site repeats the same boilerplate: check that judgment is enabled, wrap the call in a try block, rethrow only the test-only missing-recording error, return null otherwise, and later reconcile the record inside another try block that swallows failures "because it is measurement". This appears in planning (three times), the builder step, the review step, the review phase and the implementation phase.
- Seven `*-report.ts` modules (about 570 lines) compute per-decision agreement figures. Nothing calls them. The generic summary in the audit module already counts calls, modes, agreement and spend per decision.
- Tests replay recorded responses keyed by a hash of the state and the questions. Any wording change invalidates recordings, recording needs the live service and an API key, and CI cannot record. That machinery (`replay.ts`, a recorder, `tests/fixtures/judgment/`, a dedicated missing-recording error that every call site must special-case) costs more than it protects.
- The default mode is shadow, so no decision changes behavior unless the operator also finds and sets `MUSTER_JEV_MODE=enforce`. The two decisions with their own enabling flags need a third and fourth variable on top of that. The savings this series is built around are unreachable by default.
- One decision, `context.capsule_ranking`, and the modules behind it (`src/context/ranking.ts`, `escalation.ts`, `assembler.ts`) are not connected to task execution and send nothing. They are dead weight that the security documentation has to keep explaining.

## What Changes

- Split `gates.ts` into a small shared module for the decision type and helpers, a catalog, and one module per decision under `src/judgment/decisions/`.
- Add one call-site helper, `tryJudge`, that never throws for an operational failure and returns a verdict whose `reconcile` method never throws. Every call site uses it, and the special handling of missing recordings disappears.
- Replace recorded fixtures with a scripted judgment client in test helpers. Delete the replay and recorder modules, the fixtures directory and the missing-recording error. Keep one transport test that parses a canned service payload, and add a manual probe script that runs each decision's representative input against the live service and prints the answers.
- Delete the seven per-decision report modules. `/change status` shows the existing generic per-decision summary.
- **BREAKING** Make enforce the default mode once judgment is enabled by `MUSTER_JEV=1` and an API key. Shadow becomes an explicit choice. The opt-in and the egress controls do not change.
- **BREAKING** Remove the per-decision enabling variables `MUSTER_JEV_REVIEW_TRIAGE` and `MUSTER_JEV_MODEL_ROUTING`. Both decisions run whenever judgment is enabled; routing still needs an economy model to be configured, and review triage still only acts on an approved review.
- **BREAKING** Delete the `context.capsule_ranking` decision and the unwired context modules behind it, keeping only the code candidate retrieval that planning uses.
- Update the security model's call-site table and the README to match.

## Capabilities

### New Capabilities

- `judgment-catalog`: how decisions are organized (one module each), the single call-site helper, the generic summary, the absence of per-decision flags, and the manual live probe.

### Modified Capabilities

- `judgment-layer`: enforce is the default mode; tests use a scripted client rather than recordings.
- `judgment-review-triage`: triage runs whenever judgment is enabled instead of needing its own flag.
- `judgment-model-routing`: routing is inert without an economy lane but needs no flag of its own.
- `judgment-capsule-ranking`: removed entirely.

## Impact

- **Removed:** `src/judgment/replay.ts`, seven `*-report.ts` modules, `src/context/ranking.ts`, `escalation.ts`, `assembler.ts`, `tests/fixtures/judgment/`, and the tests that only covered them.
- **Reshaped:** `src/judgment/gates.ts` and `questions.ts` become `decision.ts`, `catalog.ts`, `try.ts` and eight to nine decision modules, none over about 200 lines.
- **Call sites:** planning, builder step, review step, review phase and implementation phase lose their try/catch and reconcile boilerplate.
- **Configuration:** two environment variables disappear and one default changes. `docs/security.md` and the README are updated; the egress table loses the capsule row and its enabling-variable column entries.
- **Behavior for existing users:** anyone who already set `MUSTER_JEV=1` and a key now gets enforce mode without asking. Operators who want the old behavior set `MUSTER_JEV_MODE=shadow`.
- **Persisted records:** decision records written by earlier runs are not migrated. Runs from before this change are not expected to be resumed.
- **Prerequisite:** simplify-02-prompt-files, so decision modules are written against question files rather than moved wording.
