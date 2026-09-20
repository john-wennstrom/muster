## Why

Whether a change is small or large is decided too late and used too little.

Today `/change propose` first runs a preflight agent session (read-only, up to six tool calls) to gather evidence paths, then asks Jev `planning.complexity` about that evidence, then computes a classification of `direct`, `bounded` or `architectural`. The classification only decides whether specialist opinions and a debate run and which thinking level planning uses. Review, implementation and verification are identical whatever the size, because the orchestration policy hard-codes every mandatory step to `true` for all classes.

Two Jev decisions, `planning.preflight` and `planning.complexity`, are asked about the same request, and the first sends repository excerpts that the second then asks about again. The first LLM session runs before the size is known, so a rename pays for a full read-only exploration whose only job is to find files that a code search can already list.

The change's size needs to be a first-class fact: decided once, up front, cheaply, recorded, shown to the user, and read by every later phase. Then later changes can spend less on small work without touching the guarantees that apply to all work.

## What Changes

- Add lanes: `small`, `medium`, `large`. Each change has exactly one, persisted with its run records, shown by `/change status`, and able only to move upward (escalate).
- Add one Jev decision, `change.triage`, that answers the request's disposition, the four risk questions, whether the change is mechanical, and how far it reaches, over candidate files that code retrieved. It replaces `planning.preflight` and `planning.complexity`, which are removed.
- Choose the lane before any agent session: retrieve candidates by code, ask triage once, combine the answer with the pattern-based classification, and persist the result. The pattern classification is the floor; judgment can raise the lane on any confident risk and can lower it to small only when it is confident about every risk and about reach.
- Let the user choose the lane with `--lane small|medium|large` on `/change propose` and `/change refine`. An explicit choice overrides triage.
- Replace the hard-coded orchestration policy with a declared lane policy table. In this change it carries the specialist-opinion and debate settings and whether work-reducing decisions are permitted, and later changes add fields.
- Keep the preflight agent session as the fallback for the dispositions triage cannot decide (clarification, or an unconfident answer). Change 05 removes it.
- Update the security documentation: one call-site row replaces two.

## Capabilities

### New Capabilities

- `change-lanes`: the lane concept, its persistence and escalation rule, the user override, the declared lane policy table, and the rule that no agent session is needed to choose a lane.
- `change-triage`: the merged Jev decision, when it may lower or raise a lane, how disposition is handled, shadow and unavailable behavior, and its egress row.

### Modified Capabilities

- `judgment-preflight`: removed; its still-needed behavior is restated under `change-triage`.
- `judgment-complexity`: removed; its still-needed behavior is restated under `change-triage`.

## Impact

- **New:** `src/controller/lane.ts` (types, policy table, choice, persistence), `src/judgment/decisions/change-triage.ts`, `prompts/judgment/change.triage.yaml`.
- **Removed:** the `planning.preflight` and `planning.complexity` decision modules, their question files, their tests and goldens, and the orchestration policy function.
- **Changed:** the planning phase's front half (retrieval, triage, lane, fallback preflight), the propose and refine handlers (`--lane`), the snapshot and status output (lane), and `docs/security.md`.
- **Behavior:** with judgment disabled or unavailable the lane is medium (or large when the patterns say architectural), so nothing changes for operators who do not use Jev. Small and medium are the same in behavior until changes 05 and 06 land.
- **Persisted records:** a new `lane.json` per change run. Changes planned before this change have none and are treated as medium.
- **Prerequisite:** simplify-03-judgment-core, for the one-decision-per-module layout and the enforce default.
