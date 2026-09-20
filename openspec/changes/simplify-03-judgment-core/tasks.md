## 1. Scripted client and the call-site helper

- [ ] 1.1 Add `tests/helpers/scripted-judgment.ts` exporting `createScriptedClient(script)`, where the script maps a decision id to either a fixed answer set or a function of the request returning answers keyed by question identifier, and `createDeadClient(reason)` for each unavailable reason. A request the script does not cover throws an error naming the decision (a dedicated test-helper error, not an unavailable result). Add `src/judgment/try.ts` exporting `tryJudge(runtime, decision, request)`, which returns `null` when judgment is disabled or the result is a fallback, never throws for an operational failure, and otherwise returns the verdict extended with `reconcile(observed, agreed?)`, a method that merges into the decision record and never throws (it swallows and ignores store failures). Do not remove the existing replay client yet. Add tests for the helper: disabled, unavailable, shadow verdict, enforce verdict, reconcile success, reconcile against a failing store.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/judgment/**", "tests/judgment/**", "tests/helpers/**"]
  writes: ["src/judgment/try.ts", "tests/helpers/scripted-judgment.ts", "tests/judgment/try.test.ts", "tests/judgment/scripted-client.test.ts"]
  requirements: ["judgment-layer: Tests run against a scripted client", "judgment-catalog: Call sites use one helper that never throws"]
  scenarios: ["Scripted answers are used", "An uncovered request fails the test", "Each unavailable reason can be simulated", "Disabled judgment yields no verdict", "An unavailable service yields no verdict", "Reconciliation never raises"]
  verify: ["bun test tests/judgment/try.test.ts", "bun test tests/judgment/scripted-client.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Retire recordings

- [ ] 2.1 Convert every test that uses the replay client or a recording to the scripted client or the dead client: `tests/judgment/ask.test.ts`, `complexity.test.ts`, `fallback.test.ts`, `layering.test.ts`, `review-extraction-corpus.test.ts`, `tests/muster/planning-runtime.test.ts`, `tests/muster/review-runtime.test.ts` and `tests/policies/repair-progress.test.ts`. Keep each test's intent; replace recorded answers with scripted answers that produce the same gate outcomes. Keep `tests/judgment/client.test.ts` and add to it one test that parses a canned response body in the service's documented shape and one where the body omits a requested question. Leave `tests/judgment/replay.test.ts` and the replay module in place until the next task.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/judgment/**", "tests/**"]
  writes: ["tests/judgment/**", "tests/muster/planning-runtime.test.ts", "tests/muster/review-runtime.test.ts", "tests/policies/**"]
  requirements: ["judgment-layer: Tests run against a scripted client"]
  scenarios: ["Scripted answers are used", "The transport parses the service's response shape", "Each unavailable reason can be simulated"]
  verify: ["bun test tests/judgment", "bun test tests/muster", "bun test tests/policies", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Delete `src/judgment/replay.ts`, `tests/judgment/replay.test.ts`, the whole `tests/fixtures/judgment/` directory and the missing-recording error class and its handling. Replace every call site's judgment boilerplate with `tryJudge` and `verdict.reconcile`: `src/change/phases/planning.ts` (risk inputs, preflight, task quality), `src/change/phases/task-steps/builder.ts` (routing), `src/change/phases/task-steps/review.ts` (focus), `src/review/review-extraction.ts`, `src/review/review-triage.ts`, and `src/tools/command-approval.ts`. Remove every `instanceof JudgmentFixtureMissingError` branch, every `if (!runtime.enabled) return null` guard that `tryJudge` now covers, and every try/catch around reconciliation. Behavior must be identical; the existing tests are the check.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/judgment/replay.ts", "src/judgment/ask.ts", "src/change/phases/planning.ts", "src/change/phases/task-steps/**", "src/review/review-extraction.ts", "src/review/review-triage.ts", "src/tools/command-approval.ts", "tests/fixtures/judgment/**", "tests/judgment/**", "tests/muster/**", "tests/review/**", "tests/tools/**"]
  requirements: ["judgment-catalog: Call sites use one helper that never throws", "judgment-layer: Tests run against a scripted client"]
  scenarios: ["Reconciliation never raises", "An unavailable service yields no verdict", "An uncovered request fails the test"]
  verify: ["bun test tests/judgment", "bun test tests/muster", "bun test tests/review", "bun test tests/tools", "bun run typecheck"]
  manual: null
  ```

## 3. One module per decision

- [ ] 3.1 Split `src/judgment/gates.ts`. Move the decision type, `defineDecision`, `act`, `abstain`, effect vocabulary, band helpers and `noulOf` into `src/judgment/decision.ts`. Add `src/judgment/catalog.ts` listing every decision and exposing `validateCatalog`. Move the planning decisions (`planning.complexity`, `planning.preflight`, `planning.task_quality`) with their input types, state builders, gates and presenters into `src/judgment/decisions/planning-complexity.ts`, `planning-preflight.ts` and `planning-task-quality.ts`. Update imports. Behavior and decision versions are unchanged, and the prompt goldens must still pass. Add a test that every module under `src/judgment/decisions/` defines exactly one decision and that the catalog lists it.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.2"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/judgment/**", "src/change/**", "src/controller/**", "tests/judgment/**", "tests/muster/**"]
  requirements: ["judgment-catalog: Each decision is one module"]
  scenarios: ["A decision module defines one decision", "The catalog lists every decision"]
  verify: ["bun test tests/judgment", "bun test tests/prompts", "bun test tests/muster", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Move the review decisions (`review.task_focus`, `review.extraction`, `review.triage`) the same way into `src/judgment/decisions/review-task-focus.ts`, `review-extraction.ts` and `review-triage.ts`, with their state builders and presenters. Update imports in `src/review/**` and `src/change/**`.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/judgment/**", "src/review/**", "src/change/**", "tests/judgment/**", "tests/review/**", "tests/muster/**"]
  requirements: ["judgment-catalog: Each decision is one module"]
  scenarios: ["A decision module defines one decision", "The catalog lists every decision"]
  verify: ["bun test tests/judgment", "bun test tests/prompts", "bun test tests/review", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.3 Move the execution decisions (`routing.task_model`, `command.classification`, `debugging.thrash`) into `src/judgment/decisions/routing-task-model.ts`, `command-classification.ts` and `debugging-thrash.ts`. After this task `src/judgment/gates.ts` must contain only the capsule-ranking decision, which task 4.1 deletes. Update imports in `src/tools/**`, `src/policies/**` and `src/change/**`.

  ```yaml harness-task
  id: "3.3"
  dependsOn: ["3.2"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/judgment/**", "src/tools/**", "src/policies/**", "src/change/**", "tests/judgment/**", "tests/tools/**", "tests/policies/**", "tests/muster/**"]
  requirements: ["judgment-catalog: Each decision is one module"]
  scenarios: ["A decision module defines one decision", "The catalog lists every decision"]
  verify: ["bun test tests/judgment", "bun test tests/prompts", "bun test tests/tools", "bun test tests/policies", "bun run typecheck"]
  manual: null
  ```

## 4. Remove what is not connected

- [ ] 4.1 Delete the capsule-ranking decision and everything behind it: the remaining contents of `src/judgment/gates.ts` (delete the file), its question file `prompts/judgment/context.capsule_ranking.yaml` if present, `src/context/ranking.ts`, `src/context/escalation.ts`, `src/context/assembler.ts`, and their tests and goldens. Keep `src/context/candidates.ts`. Remove the capsule entries from the temporary allowlists in `tests/layering/source-hygiene.test.ts` and `tests/prompts/exclusions.ts`, and from the catalog. Confirm by search that nothing in `src/` imports the deleted modules.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.3"]
  role: builder
  reads: ["src/**", "tests/**", "prompts/**"]
  writes: ["src/judgment/**", "src/context/**", "prompts/judgment/**", "tests/judgment/**", "tests/context/**", "tests/layering/**", "tests/prompts/**"]
  requirements: ["judgment-capsule-ranking: Necessity means needed to do the work", "judgment-capsule-ranking: Slice egress is documented"]
  scenarios: ["The catalog lists every decision"]
  verify: ["bun test tests/judgment", "bun test tests/context", "bun test tests/layering", "bun test tests/prompts", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.2 Delete the seven per-decision report modules (`complexity-report.ts`, `model-routing-report.ts`, `preflight-report.ts`, `review-extraction-report.ts`, `review-triage-report.ts`, `task-quality-report.ts`, `task-review-report.ts`) and their tests, and remove their allowlist entries. Add a judgment block to the change status output built from the existing `summarizeDecisions`: per decision the calls, acted and would-have-acted counts, unavailable reasons and agreement over reconciled records, printed only when the change has decision records. Add tests for both cases in the status tests.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["3.3"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/judgment/**", "src/change/phases/status.ts", "src/change/outcome.ts", "src/change/snapshot.ts", "tests/judgment/**", "tests/muster/**", "tests/layering/**"]
  requirements: ["judgment-catalog: One generic summary replaces per-decision reports"]
  scenarios: ["Status shows the judgment block", "Status is unchanged without records"]
  verify: ["bun test tests/judgment", "bun test tests/muster", "bun test tests/layering", "bun run typecheck"]
  manual: null
  ```

## 5. Enforce by default, no per-decision flags

- [ ] 5.1 In `src/judgment/policy.ts` make an unset `MUSTER_JEV_MODE` resolve to `enforce`, keep `shadow` selectable and any other value invalid configuration, and keep the opt-in (`MUSTER_JEV=1` and a key) exactly as it is. Remove the `decisionFlag` option and the `enabledBy` field from `Decision`, `ask.ts` and the two decisions that declared one (review triage and routing), including the exported enabling-variable constants. Remove the review phase's `triageEnabled` flag check so triage runs whenever judgment is enabled, and remove the routing flag check so routing depends only on judgment and a configured economy model. Update the tests in `tests/judgment/policy.test.ts`, the triage and routing tests and the review runtime tests accordingly, and add a catalog test that no decision declares an enabling variable.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["4.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/judgment/**", "src/change/phases/review.ts", "src/change/phases/task-steps/**", "src/change/models.ts", "tests/judgment/**", "tests/muster/**", "tests/controller/**"]
  requirements: ["judgment-layer: Enforce is the default mode once judgment is enabled", "judgment-catalog: Decisions have no separate enabling flags", "judgment-review-triage: Triage runs whenever judgment is enabled", "judgment-model-routing: Routing is inert without an economy lane"]
  scenarios: ["Default mode is enforce", "Shadow mode is explicit", "Unrecognized mode is unavailable", "A decision runs when judgment is enabled", "No decision declares a flag", "Judgment enabled runs triage without another variable", "Judgment disabled means full review", "No economy model means no routing", "Both present means routing is asked"]
  verify: ["bun test tests/judgment", "bun test tests/muster", "bun test tests/controller", "bun run typecheck"]
  manual: null
  ```

## 6. Probe and documentation

- [ ] 6.1 Add `scripts/judgment/probe.ts` and a `judgment:probe` package script. For each decision in the catalog (or the one named by an argument) it builds the decision's questions from its representative input, sends them to the live service using the configured key, and prints the answers by question identifier and whether the gate would act. It exits with an explanatory message when judgment is not configured. It must not be imported by any test.

  ```yaml harness-task
  id: "6.1"
  dependsOn: ["5.1"]
  role: builder
  reads: ["src/judgment/**", "package.json", "scripts/**"]
  writes: ["scripts/judgment/**", "package.json", "tests/judgment/probe-not-in-suite.test.ts"]
  requirements: ["judgment-catalog: A manual probe checks wording against the live service"]
  scenarios: ["The probe prints a decision's outcome", "The suite never runs the probe"]
  verify: ["bun test tests/judgment/probe-not-in-suite.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 6.2 Update `docs/security.md`: enforce is the default, `MUSTER_JEV_MODE=shadow` selects shadow, the two per-decision variables are gone, the capsule row is gone, and the enabling-variable column no longer lists a flag for triage or routing (routing's row keeps its economy-model requirement). Replace the "Recorded judgment fixtures" section of `docs/testing.md` with a short description of the scripted client and the probe script. Update the README's model-configuration paragraph. Run `bun run docs:check`.

  ```yaml harness-task
  id: "6.2"
  dependsOn: ["6.1", "4.2"]
  role: builder
  reads: ["docs/**", "README.md"]
  writes: ["docs/security.md", "docs/testing.md", "README.md"]
  requirements: ["judgment-layer: Enforce is the default mode once judgment is enabled", "judgment-catalog: Decisions have no separate enabling flags"]
  scenarios: ["Default mode is enforce", "No decision declares a flag"]
  verify: ["bun run docs:check"]
  manual: null
  ```
