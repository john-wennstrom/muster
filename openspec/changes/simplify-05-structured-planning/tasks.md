## 1. The typed plan

- [x] 1.1 Create `src/planning/plan-schema.ts` (a zod schema for the plan union: `plan`, `needs_clarification`, `already_satisfied`, with requirements, named scenarios with when and then text, an optional design with context, goals, non-goals, titled decisions, risks and migration, and tasks carrying id, group, description, dependsOn, role, reads, writes, requirement references, scenario names, verify commands and an optional manual block matching the existing manual metadata) and `src/planning/plan-validate.ts`. Export `parsePlan(text)` that extracts exactly one JSON object using the existing embedded-JSON extraction and validates it, and `validatePlan(plan, { verificationProfile })` returning a list of errors that each carry a field path and message. Checks: kebab-case capability names; task ids `N.M` and unique; every task requirement reference names a plan requirement; every cited scenario exists under a cited requirement; every requirement has at least one scenario; the dependency graph compiles as a DAG using `compileTaskDag`; every verify command parses with `parseVerificationCommand` and its executable passes `validateExecutable` for the verification profile; scopes are repository-relative and non-escaping. Also export `describePlanSchema()` returning the JSON schema text via `z.toJSONSchema` for the prompt. Add tests for each check, including a `cargo` verify command, an unresolvable reference and a cycle.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/execution/**", "src/tools/**", "src/persistence/records.ts", "tests/**"]
  writes: ["src/planning/plan-schema.ts", "src/planning/plan-validate.ts", "tests/planning/plan-validate.test.ts"]
  requirements: ["structured-planning: Planning returns a typed plan", "structured-planning: The plan is validated in code before anything is written"]
  scenarios: ["A plan is parsed", "The prompt describes the validated schema", "An unresolvable reference", "A verification command the host will refuse", "A dependency cycle"]
  verify: ["bun test tests/planning/plan-validate.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 1.2 Create `src/planning/render.ts` and the artifact templates `prompts/artifacts/proposal.md`, `design.md`, `spec.md` and `tasks.md`, using the strict renderer from `src/prompts/render.ts`. `renderArtifacts(plan, changeRoot)` returns `{ path, content }` entries for `proposal.md`, one `specs/<capability>/spec.md` per capability with ADDED, MODIFIED, REMOVED and RENAMED sections in OpenSpec delta format (four-hash `#### Scenario:` headings with `WHEN` and `THEN` lines), `design.md` (a one-line "no decisions beyond the proposal" design when the plan has none), and `tasks.md` in the existing checkbox plus `harness-task` YAML format. Paths derive only from validated capability names and fixed artifact names. `writeArtifacts` writes them, creating directories. Add tests that render a sample plan and check that the task list parses and validates with the existing task loader, that each spec has scenarios in the required heading format, that paths never escape the change root, and a golden of the rendered artifacts.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/planning/**", "src/execution/**", "src/prompts/**", "tests/**"]
  writes: ["src/planning/render.ts", "prompts/artifacts/**", "tests/planning/render.test.ts", "tests/planning/golden/**"]
  requirements: ["structured-planning: Code renders every artifact", "structured-planning: Every lane writes all four artifacts"]
  scenarios: ["Artifacts are written from the plan", "The session cannot choose a path", "A small plan without a design"]
  verify: ["bun test tests/planning/render.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. The planning session and orchestration

- [x] 2.1 Write the planning prompts as files: `prompts/agents/planning-plan.md` (variables for the change name, request, lane guidance, lane task limit, authoritative context, the generated plan schema, the current artifacts for refinement, required changes from a revising review, prior analysis from opinions and a debate, and an optional block of validation failures from a previous attempt), `planning-opinion.md` and `planning-debate.md`. Create `src/planning/session.ts` with `runPlanningSession(kind, variables, options)` wrapping the single spawn entry point with the planning thinking rules (low for direct, medium for bounded, configured for architectural), usage recording and the planning timeout, and `src/planning/budget.ts` holding the token and cost limit parsing moved from the phase, with the defaults stated in the code and the README aligned to them. Add goldens for the three prompts under `tests/prompts/golden/agents/` and tests for the session wrapper with the spawn entry point stubbed.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/**", "prompts/**", "tests/**"]
  writes: ["prompts/agents/planning-plan.md", "prompts/agents/planning-opinion.md", "prompts/agents/planning-debate.md", "src/planning/session.ts", "src/planning/budget.ts", "tests/planning/session.test.ts", "tests/planning/budget.test.ts", "tests/prompts/golden/agents/**"]
  requirements: ["structured-planning: Lane guidance shapes the plan", "structured-planning: Refinement returns a whole plan", "structured-planning: Validation failures get one specific retry"]
  scenarios: ["Small guidance is present", "Required changes are folded in", "The retry names the failures"]
  verify: ["bun test tests/planning", "bun test tests/prompts", "bun run typecheck"]
  manual: null
  ```

- [x] 2.2 Rewrite planning orchestration in `src/planning/run.ts` and reduce `src/change/phases/planning.ts` to phase entry and outcome mapping. Flow: read the lane and triage result from change 04's front half (retrieval, triage, lane, `lane.json`), run specialist opinions and a debate only as `LANE_POLICY[lane]` and the optional budget allow, then run the plan session with the mandatory synthesis budget forecast. Parse and validate the plan; on failure retry once with the failure list in the prompt; a second failure fails the command with the list. Handle `needs_clarification` and `already_satisfied` dispositions with the existing blocked outcomes. On a plan, write the artifacts with `writeArtifacts`. Delete the preflight agent prompt, schema and parser, the artifact bundle parser and path guard, the plan-time task quality call, and the writeArtifacts retry loop in `src/controller/planning.ts` (keep opinion, debate and synthesis sequencing). Delete `tests/muster/planning-runtime.test.ts` and replace it with focused tests for the orchestration using stubbed sessions: a clean small plan, a large plan with opinions and a debate, a clarification, an already-satisfied report, a validation failure followed by success, and two failures.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["1.2", "2.1"]
  role: builder
  reads: ["src/**", "prompts/**", "tests/**"]
  writes: ["src/planning/run.ts", "src/change/phases/planning.ts", "src/controller/planning.ts", "src/change/handlers/propose.ts", "src/change/handlers/refine.ts", "tests/planning/**", "tests/muster/planning-runtime.test.ts", "tests/controller/**", "tests/layering/**"]
  requirements: ["structured-planning: Disposition is part of the planning session", "structured-planning: Validation failures get one specific retry", "structured-planning: Planning is decomposed into a library", "structured-planning: Refinement returns a whole plan"]
  scenarios: ["The session asks for clarification", "No preflight session runs", "A second failure ends the command", "The retry names the failures", "The phase file is thin", "Required changes are folded in"]
  verify: ["bun test tests/planning", "bun test tests/controller", "bun test tests/layering", "bun run typecheck"]
  manual: null
  ```

## 3. Lint, the semantic check and the review path

- [x] 3.1 Extend `LANE_POLICY` in `src/controller/lane.ts` with `planReview` (`lint` for small, `reviewer` for medium and large), `maxTasks` (2, 40, 40) and `allowManualTasks` (false, true, true). Create `src/review/plan-lint.ts`: `lintChange({ changeRoot, lane, profile })` reads the artifacts on disk and returns `{ errors, escalations }`. Errors (block the command): artifacts missing or unparsable; tasks fail validation; a requirement or scenario reference does not resolve against the real `specs/**/spec.md` files in the change; a scenario cited by no task; a task with no requirement, scenario or verify command; a verify command that does not parse or whose executable the profile forbids; a write scope matching the credential denylist (reuse the egress denylist matcher) or `.git`; a dependency cycle. Escalations (small lane only): task count above the lane limit, or a manual task. Strict OpenSpec validation runs through the existing adapter and its failure is an error. Add tests for each check and each escalation.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["src/review/plan-lint.ts", "src/controller/lane.ts", "tests/review/plan-lint.test.ts", "tests/controller/lane.test.ts"]
  requirements: ["plan-lint: Lint checks are deterministic and complete", "plan-lint: Lane limits escalate instead of failing", "plan-lint: Lint runs before any reviewer"]
  scenarios: ["References resolve against real specifications", "A credential file in a write scope", "An uncovered scenario", "Too many tasks for small", "A manual task on the small lane", "A lint failure blocks without a reviewer"]
  verify: ["bun test tests/review/plan-lint.test.ts", "bun test tests/controller/lane.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 3.2 Create the `plan.lint` decision in `src/judgment/decisions/plan-lint.ts` and `prompts/judgment/plan.lint.yaml`. Move the six task-quality concerns (verification, scope, atomicity, dependencies, size, coverage) and their question wording from the existing `planning.task_quality` decision, its state builder (bounded at 40 tasks, summary excerpt at most 2,000 bytes) and its fixed finding templates, keeping wording unchanged except the decision id and version. Effects: `adds_advice` and `reduces_work`. The gate returns findings plus an `uncertain` list of concerns that were neither confidently clean nor confidently a finding. Delete the `planning.task_quality` decision module, its question file and golden, `src/controller/task-quality.ts` (the record binding, current-notes lookup and outcome reconciliation), and the reconciliation call in `src/change/phases/implementation.ts`. Update the catalog and the exclusion lists. Add tests with the scripted client for clean, finding, uncertain and over-limit cases.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["2.2"]
  role: builder
  reads: ["src/**", "prompts/**", "tests/**"]
  writes: ["src/judgment/**", "src/controller/task-quality.ts", "src/change/phases/implementation.ts", "src/change/phases/review.ts", "prompts/judgment/**", "tests/judgment/**", "tests/controller/**", "tests/muster/**", "tests/prompts/**"]
  requirements: ["plan-lint: The semantic check state is bounded and excerpted", "plan-lint: Semantic findings are generated by code"]
  scenarios: ["Too many tasks", "A finding is a template"]
  verify: ["bun test tests/judgment", "bun test tests/prompts", "bun test tests/muster", "bun run typecheck"]
  manual: null
  ```

- [x] 3.3 Add `mode` (`reviewer` or `lint`) and an optional `lint` block (checks that ran, judged answers, whether the semantic check ran) to the planning review artifact schema and its renderer and parser in `src/review/review-artifact.ts`; a file without a mode parses as `reviewer`. In `deriveLifecycle`/`createChangeSnapshot` treat a lint review as current only when the change's lane is small and the artifact digest matches, so escalating makes the lifecycle `REVIEW_REQUIRED`. Add tests: round trip of both modes, an older file without a mode, a lint approval after escalation.

  ```yaml harness-task
  id: "3.3"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/review/**", "src/controller/**", "src/change/**", "tests/**"]
  writes: ["src/review/review-artifact.ts", "src/controller/change-snapshot.ts", "src/change/snapshot.ts", "tests/review/**", "tests/controller/**"]
  requirements: ["plan-lint: Lint approvals are recorded honestly", "plan-lint: A lint approval is current only on the small lane"]
  scenarios: ["A lint approval names lint", "An older review file", "Escalation invalidates a lint approval"]
  verify: ["bun test tests/review", "bun test tests/controller", "bun run typecheck"]
  manual: null
  ```

- [x] 3.4 Rework `runProductionReview` in `src/change/phases/review.ts` and `reviewChange` in `src/controller/review.ts`. New order: run `lintChange`; if there are errors, return a blocked outcome listing all of them, with no reviewer and no judgment request. If the lane is small: escalations from lint move the change to medium through `escalateLane` and continue to the reviewer; otherwise ask `plan.lint` once through `tryJudge` (skipped when the state is over the limit, which escalates); a clean confident answer, or an unavailable service, writes a lint review (`mode: lint`, `model: lint`, the checks that ran, and whether the semantic check ran) and returns success with next `/change implement`; a confident finding or an uncertain concern escalates to medium and continues. Otherwise (medium, large, or escalated) dispatch the reviewer exactly as today, with `plan.lint` findings passed as unverified notes when the service answered, and keep review triage's carry-forward for the reviewer path. Add tests for: lint failure blocks with no reviewer, clean small plan approved by lint, finding escalates and runs the reviewer, uncertain escalates, unavailable approves by lint, medium runs the reviewer with notes, and the small-lane over-limit case.

  ```yaml harness-task
  id: "3.4"
  dependsOn: ["3.1", "3.2", "3.3"]
  role: builder
  reads: ["src/**", "prompts/**", "tests/**"]
  writes: ["src/change/phases/review.ts", "src/controller/review.ts", "src/review/**", "tests/review/**", "tests/commands/review.test.ts", "tests/muster/review-runtime.test.ts", "tests/controller/**"]
  requirements: ["plan-lint: Lint runs before any reviewer", "plan-lint: The small lane is approved by lint and a semantic check", "plan-lint: Medium and large lanes keep the reviewer", "plan-lint: Lane limits escalate instead of failing", "plan-lint: The semantic check state is bounded and excerpted"]
  scenarios: ["A lint failure blocks without a reviewer", "A clean small plan is approved without a reviewer", "A finding escalates", "An uncertain concern escalates", "Unavailable judgment does not escalate", "Findings are notes only", "Too many tasks for small", "Too many tasks"]
  verify: ["bun test tests/review", "bun test tests/commands/review.test.ts", "bun test tests/muster/review-runtime.test.ts", "bun test tests/controller", "bun run typecheck"]
  manual: null
  ```

## 4. Documentation

- [x] 4.1 Update `docs/security.md`: replace the `planning.task_quality` row with a `plan.lint` row (sent once per `/change review`, over the change summary excerpt of at most 2,000 bytes, requirement and scenario text excerpted with names kept, and each task's description, dependencies, scopes and verify commands; no more than 40 tasks; findings are templates written by code; on the small lane the answer can approve without a reviewer and any doubt escalates). Update the README planning and review sections for the typed plan, plan lint, lanes and the small-lane path. Extend `prompts/README.md` with the `prompts/artifacts/` templates. Run `bun run docs:check`.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.4", "2.2"]
  role: builder
  reads: ["docs/**", "README.md", "prompts/**"]
  writes: ["docs/security.md", "README.md", "prompts/README.md"]
  requirements: ["plan-lint: Semantic check egress is documented"]
  scenarios: ["One row replaces one"]
  verify: ["bun run docs:check"]
  manual: null
  ```
