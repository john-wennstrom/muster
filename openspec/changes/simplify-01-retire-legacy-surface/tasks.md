## 1. Delete unwired code and add the guard

- [ ] 1.1 Add `tests/layering/source-hygiene.test.ts`. It walks every `.ts` file under `src/`, resolves relative imports, and fails for any module that no other non-test module imports and that is not in a declared entry-point list containing `src/muster/index.ts` and `src/agents/child-broker.ts`. Include a temporary allowlist, one line per entry naming the responsible change, containing `src/context/ranking.ts`, `src/context/escalation.ts` and `src/context/assembler.ts` (simplify-03-judgment-core), the seven `src/judgment/*-report.ts` files (simplify-03-judgment-core), and `src/policies/repair-progress.ts` (simplify-06-lean-execution). Delete `src/agents/model-router.ts`, `src/controller/state-precedence.ts`, `src/change/manual-ui.ts` and `src/telemetry/report.ts` together with every test that only covers them. Check first that none is imported by a production module; if one is, keep it and report the importer instead of deleting.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/agents/model-router.ts", "src/controller/state-precedence.ts", "src/change/manual-ui.ts", "src/telemetry/report.ts", "tests/layering/**", "tests/agents/**", "tests/controller/**", "tests/telemetry/**", "tests/muster/**"]
  requirements: ["source-hygiene: Every source module has a production importer or is a declared entry point", "source-hygiene: Modules without a production caller are deleted"]
  scenarios: ["A module with only test importers fails the guard", "A declared entry point passes", "The allowlist names its owner", "The four modules are gone"]
  verify: ["bun test tests/layering", "bun run typecheck"]
  manual: null
  ```

## 2. Move the shared runtime into src

- [ ] 2.1 Move the extension's `modules/model-stack.ts` to `src/agents/model-stack.ts`, the run record and helpers from `modules/runtime.ts` (`AgentRun`, `newRun`, `runOk`, `runError`, `Role`, usage and stat helpers, `ChildStatus`) to `src/agents/run-record.ts`, and the child runtime resolution (`READONLY_TOOLS`, `FULL_TOOLS`, `VALIDATOR_TOOLS`, `resolveChildRuntime`, `ChildAccess`, `ResolvedChildRuntime`) to `src/agents/child-runtime.ts`. Use `git mv` semantics where a file moves whole. Rewrite every import under `src/` and every test import to the new locations, and move the matching extension tests (`model-stack.test.ts`, `child-runtime.test.ts`) to `tests/agents/`. The extension keeps working by importing from the new locations. Leave the panel-rendering parts of `runtime.ts` in place for now.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/**", "extensions/**", "tests/**"]
  writes: ["src/agents/**", "src/change/**", "src/review/**", "src/telemetry/**", "src/execution/**", "extensions/fusion-harness/**", "tests/agents/**", "tests/muster/**", "tests/review/**"]
  requirements: ["agent-runtime: The source tree does not depend on retired code"]
  scenarios: ["Model stack loading is unchanged"]
  verify: ["bun test tests/agents", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Move `AgentGrid`, `liveColumn` and `fitLines` (with the small helpers they need) from the extension's `tui.ts` to `src/change/ui/agent-columns.ts` and update `src/change/agent-progress.ts` to import from there. Add or move a test that renders two live columns from two `AgentRun` records without importing anything under `extensions/`.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/change/**", "extensions/fusion-harness/modules/tui.ts", "tests/**"]
  writes: ["src/change/ui/**", "src/change/agent-progress.ts", "tests/muster/**"]
  requirements: ["agent-runtime: Agent progress presentation is owned by the change surface"]
  scenarios: ["Progress renders without the extension"]
  verify: ["bun test tests/muster", "bun run typecheck"]
  manual: null
  ```

## 3. Collapse the spawn layers

- [ ] 3.1 Create `src/agents/spawn.ts` exporting `runAgent(options)` with `options.access` of `"read"` or `"write"`. Read mode replaces `runLegacyReadOnlyChild`. Write mode replaces `runLegacyBrokeredChild` and takes the task, the existing writer lease and the judgment hook it takes today. Move the `pi --mode json -p` process invocation from the extension's `child-runner.ts` (`piInvocation`, `runChild`) and the broker-server start and tool wiring from `src/agents/child-runner.ts` into private functions in this module, or into a sibling file it imports, keeping one place that launches the Pi executable. Update every call site (exploration, planning, planning review, builder step, task review step) to call `runAgent`. Delete `src/agents/legacy-adapter.ts` including the scope planner (`runLegacyScopePlannerChild`, `planLegacyWriteTask`, `legacyScopePlanningPrompt`, `validateLegacyScopePlan`). Keep `src/agents/role-runner.ts` and `src/agents/child-broker.ts`. Keep existing behavior: same timeouts, thinking levels, session directories, tool sets and usage recording. Port the existing child-runner and adapter tests to the new entry point and add one test asserting that only one module under `src/` references the Pi executable invocation.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "extensions/fusion-harness/modules/child-runner.ts", "tests/**"]
  writes: ["src/agents/**", "src/change/**", "src/review/**", "extensions/fusion-harness/**", "tests/agents/**", "tests/muster/**", "tests/review/**", "tests/commands/**"]
  requirements: ["agent-runtime: One child-agent entry point"]
  scenarios: ["A read-only agent uses the entry point", "A builder uses the same entry point as a writer", "No second spawn path exists"]
  verify: ["bun test tests/agents", "bun run typecheck"]
  manual: null
  ```

## 4. Retire the extension

- [ ] 4.1 Delete the `extensions/` directory entirely, including its tests, `import-manifest.json` and `verify-import.ts`, and delete the root `prompts/duckdb/` demo prompts that only the retired `/fh-*` commands used. Rewrite `src/muster/index.ts` so `registerMuster` registers only the `/change` command and the five flags `fh-config`, `architect`, `builder`, `planning-max-tokens` and `planning-max-cost` (reuse the descriptions from the deleted registrations for the first three). Remove the `extensions` entry from `package.json` `files`, the `test:fusion-harness` and `verify:import` scripts, and update `scripts/ci/validate.ts` and `.github/workflows/cross-platform.yml` so they no longer expect them. Delete any test that only asserts the presence of retired commands and move `tests/extension/install-smoke.test.ts` to assert that registration yields exactly the `change` command and the five flags.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["2.2", "3.1"]
  role: builder
  reads: ["src/**", "extensions/**", "scripts/**", ".github/**", "package.json", "tests/**"]
  writes: ["extensions/**", "prompts/duckdb/**", "src/muster/**", "package.json", "scripts/ci/**", ".github/workflows/**", "tests/extension/**", "tests/muster/**", "tests/acceptance/**"]
  requirements: ["command-surface: The change command is the only registered command", "command-surface: Retired commands are removed rather than aliased", "command-surface: Flags the pipeline reads are registered by the entry point", "agent-runtime: The source tree does not depend on retired code", "change-module-layout: Stable extension entry point"]
  scenarios: ["Registration lists one command", "A retired command is not registered", "No migration stub remains", "A flag is accepted", "Unread flags are not registered", "No import reaches the extension directory", "Only the change surface is registered", "Extension is installed after the reorganization"]
  verify: ["bun test tests/extension", "bun run typecheck", "bun run ci:validate"]
  manual: null
  ```

## 5. Documentation

- [ ] 5.1 Rewrite the README's "Legacy command migration" section as a short "Retired commands" note (the list of removed commands and that `/change explore` and the YAML config replace them), update the `AGENTS.md` architecture section to describe one system, remove references to the extension from `docs/testing.md`, `docs/roadmap.md` and `docs/security.md` where they mention `/fh-*`, and remove `justfile.template` recipes that assume the extension. Run `bun run docs:check`.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["4.1"]
  role: builder
  reads: ["README.md", "AGENTS.md", "docs/**", "justfile.template"]
  writes: ["README.md", "AGENTS.md", "docs/testing.md", "docs/roadmap.md", "docs/security.md", "justfile.template"]
  requirements: ["command-surface: Retired commands are removed rather than aliased"]
  scenarios: ["No migration stub remains"]
  verify: ["bun run docs:check"]
  manual: null
  ```
