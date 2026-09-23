## Context

`src/muster/index.ts` registers the extension and then `/change`. The extension owns flag registration (11 flags, three of which the pipeline reads through `readCliFlag`; it also reads `planning-max-tokens` and `planning-max-cost`, which nothing registers), an in-process orchestration engine for the `/fh-*` commands, and the legacy `/refine`, `/implement` and `/ship` handlers that predate the controller. The pipeline reads from the extension: `model-stack.ts` (slot and stack types, YAML loading), `runtime.ts` (`AgentRun`, `newRun`, `runOk`, `runError`, child runtime resolution, roles), `child-runner.ts` (`runChild`, which actually spawns `pi --mode json -p`), `tui.ts` (`AgentGrid`, `liveColumn`, `fitLines`, used by the progress observer) and `collaboration-graph.ts` (a task type used by one adapter).

The spawn stack today: `runChild` (extension) is wrapped by `runBrokeredChild` (broker server plus tool wiring), which is wrapped by `runLegacyBrokeredChild` and `runLegacyReadOnlyChild` (the two functions every phase calls), with `role-runner` supplying fresh session identities. `runLegacyScopePlannerChild` and `planLegacyWriteTask` exist for the retired commands only; the production builder step passes declared task scopes instead of planning them.

Four modules have no production importer: `agents/model-router.ts`, `controller/state-precedence.ts`, `change/manual-ui.ts`, `telemetry/report.ts`. `agents/child-broker.ts` also has no importer but is loaded by path as the child-side extension, so it is an entry point, not dead code.

## Goals / Non-Goals

**Goals:**

- One command surface, one spawn path, no dependency from `src/` on any retired code.
- Make it structurally hard for unwired code to accumulate.
- Keep flag names, model-stack YAML, persisted records and `/change` behavior exactly as they are.

**Non-Goals:**

- Changing any `/change` behavior, prompt, judgment call or persisted format. Later changes in the series do that.
- Renaming the flags. `--fh-config` keeps its name even though the extension it was named after is gone.
- Preserving the `/fh-*` orchestration modes in another form.

## Decisions

### 1. Move first, delete second

The pipeline's imports are rewritten to `src/` locations while the extension still exists, so each step keeps the suite green. Only when no `src/` file imports `extensions/` is the directory deleted. Deleting first would leave 25 broken imports and a non-compiling tree for several tasks.

### 2. Layout of the moved code

- `src/agents/model-stack.ts` from the extension's `model-stack.ts` (unchanged types and YAML loader).
- `src/agents/run-record.ts` for `AgentRun`, `newRun`, `runOk`, `runError`, usage and role types.
- `src/agents/child-runtime.ts` for tool sets and `resolveChildRuntime`.
- `src/change/ui/agent-columns.ts` for `AgentGrid`, `liveColumn` and `fitLines`, the only terminal code the pipeline uses. The rest of `tui.ts` (panel renderers for `/fh-*`) is deleted.

`collaboration-graph.ts` is not moved. The adapter that needs its task type takes the fields it uses directly.

### 3. One spawn entry point

`src/agents/spawn.ts` exports `runAgent(options)` where `options.access` is `"read"` or `"write"`. Read mode is today's read-only child. Write mode is today's brokered writer, taking the task, the existing writer lease and the judgment hook. It contains the `pi` process invocation currently in the extension's `runChild`, the broker server start, and the tool wiring, in that order, as small private functions. `role-runner.ts` stays as the fresh-session helper because it is small and independent. `child-broker.ts` stays as the child-side entry point.

Rejected alternative: keep the layering and only rename. It preserves the five call chains that make child changes hard to reason about.

### 4. Flags

The entry point registers exactly the five flags the pipeline reads (`fh-config`, `architect`, `builder`, `planning-max-tokens`, `planning-max-cost`), with the descriptions the extension used for the first three. Registering the two planning flags fixes a latent gap: the pipeline reads them from the command line but nothing registers them, so a strict host would reject them. The other eight registered flags (`max-validations`, `escalate-to-validator-count`, `architect-system-prompt`, `builder-system-prompt`, `architect-thinking`, `builder-thinking`, `rounds`, `child-timeout`) served retired commands and are dropped. Any read of them inside the moved model-stack code is removed with it; the same settings stay available through the YAML config.

### 5. The unwired-module guard

`tests/layering/source-hygiene.test.ts` walks `src/**/*.ts`, resolves relative imports, and fails for any module that no other non-test module imports and that is not in a short declared list of entry points (`muster/index.ts`, `agents/child-broker.ts`). During the series some modules are known-unwired until the change that deletes or wires them lands, so the test carries an allowlist with one line per entry naming the change responsible. Change 07 asserts the allowlist is empty.

Rejected alternative: a lint rule. The repository has no lint step, and a Bun test runs everywhere CI already does.

### 6. No migration stubs

A retired command is not replaced by a message that says it is retired. Pi already reports unknown commands, and a stub is code that has to be kept and removed again.

## Risks / Trade-offs

- **Users of `/fh-*` lose a working diagnostic surface** -> The README states the retirement and points to `/change explore` for read-only investigation. `/fh-only`, `/fh-model` and `/fh-system-prompt` were model-stack conveniences; the YAML config and `--architect`/`--builder` flags remain.
- **A moved type changes shape by accident** -> Files are moved with git history intact and imports rewritten mechanically; the existing suite and a typecheck run after each move.
- **The guard test flags legitimate dynamic entry points** -> The declared entry-point list is explicit and reviewed, and two entries exist today.
- **The Windows fixture failures already in the suite obscure regressions** -> Compare failure counts before and after each task, as AGENTS.md prescribes.

## Migration Plan

Land the moves and the spawn consolidation first, then the deletion, then the guard test and documentation. Each task leaves `bun run typecheck` and the suite passing. There is no data migration. Rollback is a revert; nothing persisted depends on the deleted code.
