## 1. Shared Surface Modules

- [ ] 1.1 Create the consolidated command surface directory and move the dispatcher, registration, outcome rendering, branding, command metadata, handler contract, agent progress, manual interface, and snapshot modules into it; update every importing file and verify typechecking and the full suite match the recorded baseline.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/**", "tests/**", "scripts/**"]
  writes: ["src/change/**", "src/runtime/**", "src/muster/**", "tests/**"]
  requirements: ["change-module-layout: Two-layer command surface"]
  scenarios: ["Handler module is inspected"]
  verify: ["bun run typecheck", "bun run ci:test"]
  manual: null
  ```

## 2. Phase Layer

- [ ] 2.1 Move the planning and implementation phase runners into the phase layer, and relocate the verification command-parsing helper out of the implementation runner into the execution layer so both of its consumers reach it without importing each other; verify execution and command tests pass.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/change/phases/**", "src/execution/**", "src/runtime/**", "tests/**"]
  requirements: ["change-module-layout: Two-layer command surface"]
  scenarios: ["Phase gains a second consumer"]
  verify: ["bun test tests/execution tests/commands", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Extract the review, verification, and finish phase logic out of their command modules into the phase layer, leaving each command module containing only its handler; verify each of those three actions still reaches its phase through the default registration.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/change/**", "src/muster/**", "tests/**"]
  requirements: ["change-module-layout: Two-layer command surface"]
  scenarios: ["Phase is used by one action", "Handler module is inspected"]
  verify: ["bun test tests/e2e tests/commands tests/muster", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.3 Move each phase's options type beside its phase runner and update the shared command types to reference them, removing the imports that currently point from shared types into command modules; verify typechecking succeeds with no remaining import from shared types into a handler module.

  ```yaml harness-task
  id: "2.3"
  dependsOn: ["2.2"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/change/**", "tests/**"]
  requirements: ["change-module-layout: One-directional layer dependencies"]
  scenarios: ["Phase declares the options it accepts"]
  verify: ["bun run typecheck", "bun run ci:test"]
  manual: null
  ```

## 3. Handler Layer and Assembly

- [ ] 3.1 Move the nine per-action handler modules into the handler layer and update the dependency assembly to import them from their new locations; verify every advertised action is still reachable through the default registration.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.3"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/change/**", "src/muster/**", "tests/**"]
  requirements: ["change-module-layout: Two-layer command surface"]
  scenarios: ["Handler module is inspected"]
  verify: ["bun test tests/e2e/production-command-assembly.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Move the dependency assembly into the surface directory and make the manifest-declared extension entry point re-export from it, keeping its external path and registration signature unchanged; verify the extension install smoke test passes unmodified.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/**", "package.json", "tests/extension/**"]
  writes: ["src/change/**", "src/muster/index.ts"]
  requirements: ["change-module-layout: Stable extension entry point"]
  scenarios: ["Extension is installed after the reorganization"]
  verify: ["bun run test:extension-smoke", "bun run typecheck"]
  manual: null
  ```

## 4. Guards and Documentation

- [ ] 4.1 Add a test that walks the command surface's import graph and fails if any import leads from the phase layer or the shared command types back into the handler layer; verify it fails when a deliberate back-import is introduced and passes on the current tree.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.2"]
  role: builder
  reads: ["src/change/**", "tests/**"]
  writes: ["tests/muster/module-layout.test.ts"]
  requirements: ["change-module-layout: One-directional layer dependencies"]
  scenarios: ["Dependency direction is checked"]
  verify: ["bun test tests/muster/module-layout.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.2 Search the repository for remaining references to the former directory names in source, tests, scripts, agent guidelines, wiring instructions, and roadmap or design documents, and update each to a path that exists; verify the documentation check passes and the search returns no stale references.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1"]
  role: builder
  reads: ["src/**", "tests/**", "scripts/**", "docs/**", "AGENTS.md", ".github/**"]
  writes: ["docs/**", "AGENTS.md", ".github/instructions/**", "scripts/**"]
  requirements: ["change-module-layout: Documented paths match the source layout"]
  scenarios: ["Guidance is consulted after a move", "Stale path remains"]
  verify: ["bun run docs:check", "bun run typecheck"]
  manual: null
  ```

## 5. Verification

- [ ] 5.1 Run the full cross-platform validation set and compare pass/fail counts against the recorded pre-existing platform baseline, confirming the reorganization introduced no behavioral change.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["4.2"]
  role: validator
  reads: ["src/**", "tests/**", "docs/testing.md"]
  writes: []
  requirements: ["change-module-layout: Two-layer command surface", "change-module-layout: One-directional layer dependencies"]
  scenarios: ["Handler module is inspected", "Dependency direction is checked"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run test:extension-smoke", "bun run ci:validate", "bun run docs:check"]
  manual: null
  ```
