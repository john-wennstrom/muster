## 1. Budgets

- [x] 1.1 Delete the temporary allowlist in `tests/layering/source-hygiene.test.ts` and the exclusion list `tests/prompts/exclusions.ts`, so the guard and the prompt-template test have no exceptions. Fix whatever they then report: delete any remaining module with no production importer (for example `src/integrations/optional-adapters.ts` if planning no longer uses it), and add a question file for any catalogued decision that lacks one. Add `tests/layering/size-budget.test.ts`: it fails and names any `src/**/*.ts` file over 500 lines, and any `tests/**/*.ts` file over 600 lines whose first comment lacks a line starting `size-budget:` with a reason. Run it and list what it reports before fixing.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/**", "tests/**", "prompts/**"]
  writes: ["src/integrations/**", "src/**/*.ts", "prompts/judgment/**", "tests/layering/**", "tests/prompts/**"]
  requirements: ["harness-budgets: The temporary allowlists are empty", "harness-budgets: No source module exceeds a size budget", "harness-budgets: Test files stay reviewable"]
  scenarios: ["No module is allowlisted", "Every decision has a question file", "A module over the budget fails", "An unjustified large test file fails", "A justified exception passes"]
  verify: ["bun test tests/layering/source-hygiene.test.ts", "bun test tests/prompts", "bun run typecheck"]
  manual: null
  ```

- [x] 1.2 Bring every file that the size-budget test reports under its budget. For a source module over 500 lines, split it along its responsibilities into modules of a single concern, keeping public exports stable through the existing import paths and moving tests with the code. For a test file over 600 lines, split it by concern into several files, keeping every test, or add a `size-budget:` comment with a real reason where a single scenario legitimately needs the length (for example a long end-to-end lifecycle). Do not delete tests to meet the budget. Finish with the size-budget test passing.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/**", "tests/**"]
  requirements: ["harness-budgets: No source module exceeds a size budget", "harness-budgets: Test files stay reviewable"]
  scenarios: ["A module over the budget fails", "An unjustified large test file fails", "A justified exception passes"]
  verify: ["bun test tests/layering/size-budget.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Session budgets

- [x] 2.1 In `tests/e2e/`, add a session-counting wrapper around the substituted agent child runner in the lifecycle test helpers, recording the kind of each agent started (plan, opinion, debate, builder, planning reviewer, task reviewer). Add three scenarios driving propose, review, implement and verify with stubs: a small-lane one-task change with a scripted judgment client answering triage as small, `plan.lint` clean and every focus question good, asserting at most three sessions and no planning reviewer; a medium-lane one-task change with judgment unavailable, asserting at most four sessions; and a large-lane change asserting that opinions and a debate start before the plan session. State in a comment that the figures are the series' promise and must be changed only with a stated reason.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["tests/e2e/**", "tests/helpers/**"]
  requirements: ["harness-budgets: A small change has an agent-session budget"]
  scenarios: ["A small change stays within three sessions", "A medium change stays within four sessions", "A large change runs opinions and a debate"]
  verify: ["bun test tests/e2e", "bun run typecheck"]
  manual: null
  ```

## 3. Documentation refresh

- [x] 3.1 Rewrite the README's workflow, planning cost, model configuration and security sections for the pipeline as it now is: the three lanes and how one is chosen (triage, pattern floor, the `lane=` argument), the small-lane path (one plan session, lint approval, at most one builder and an optional review), the typed plan and plan lint, that judgment is enforce by default once `MUSTER_JEV=1` and a key are set with `MUSTER_JEV_MODE=shadow` selecting shadow, the economy builder and reviewer models and thinking per task, skipped reviews and their labelling, task recovery, and the retired commands (a short note listing them, not an alias table). Update `AGENTS.md` for the single system and the new layout (`src/planning/`, `src/prompts/`, `src/judgment/decisions/`, `prompts/`), `docs/roadmap.md` to drop completed items and the old extension, `docs/testing.md` for the scripted client, the probe, the budgets and the new guards, and `prompts/README.md` for anything added by earlier changes. Do not describe any retired command as available.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "docs/**", "README.md", "AGENTS.md", "prompts/**", "package.json"]
  writes: ["README.md", "AGENTS.md", "docs/roadmap.md", "docs/testing.md", "prompts/README.md"]
  requirements: ["documentation-currency: Documentation describes lanes and the retired surface"]
  scenarios: ["The README describes lanes", "No retired command is described as available"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [x] 3.2 Regenerate `docs/command-flow.md` from the code as it now is, keeping the legend and the red (LLM session) and green (Jev call) marking, and add the lane branches: the propose flow (retrieve candidates, triage, lane, plan session, validation, normalization and rendering), the review flow (lint, `plan.lint`, lint approval or escalation, reviewer), the per-task pipeline (routing with thinking, builder, verification, review or skip, failure record and recovery decision), verify with evidence reuse, and the judgment runtime with enforce as the default. It must mention every action in the command table and every catalogued decision id. Update `docs/simplification.md` to mark the recommendations implemented, record the four decisions taken (all lanes write OpenSpec, code lint acceptable for small changes, commands stay deliberate steps, beta break with no migration), and leave a section for the measured figures from the manual acceptance run. Update `docs/e2e-chain-test.md`: rerun-friendly job for two lanes (a single-function job that should take the small lane, and a two-file job with disjoint write scopes so the DAG still has a dependency now that same-scope chains merge), the expected session counts, `lane=` usage, the enforce default, and the removed variables. Run `bun run docs:check` and confirm every diagram parses.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "docs/**", "prompts/**"]
  writes: ["docs/command-flow.md", "docs/simplification.md", "docs/e2e-chain-test.md"]
  requirements: ["documentation-currency: The command flow document names every action and decision", "documentation-currency: Documentation describes lanes and the retired surface"]
  scenarios: ["A missing action fails the check", "A missing decision fails the check", "No retired command is described as available"]
  verify: ["bun run docs:check"]
  manual: null
  ```

## 4. Enforce the documentation

- [x] 4.1 Extend `scripts/docs/check.ts` with two checks: every decision id in the judgment catalog appears in the first column of the call-site table in `docs/security.md`, and `docs/command-flow.md` mentions every action in the command table and every catalogued decision id. Each failure names what is missing. Add tests in `tests/docs/` that run the checks against fixture documents with a decision or action removed. Fix any documentation the new checks report.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.1", "3.2"]
  role: builder
  reads: ["scripts/docs/**", "src/**", "docs/**", "tests/**"]
  writes: ["scripts/docs/check.ts", "docs/security.md", "docs/command-flow.md", "tests/docs/**"]
  requirements: ["documentation-currency: The security table names every decision", "documentation-currency: The command flow document names every action and decision"]
  scenarios: ["A decision without a row fails the check", "A complete table passes", "A missing action fails the check", "A missing decision fails the check"]
  verify: ["bun test tests/docs", "bun run docs:check"]
  manual: null
  ```
