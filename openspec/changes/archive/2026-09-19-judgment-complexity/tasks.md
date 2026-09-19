## 1. Inputs and Decision

- [x] 1.1 Extract the four pattern rules from the planning phase into a pure function in `src/controller/complexity-inputs.ts` and add a pure merge of pattern values, confident judged values, and the phase, leaving `src/controller/complexity-router.ts` unedited; verify with tests that the extracted rules equal the original expressions over a table of prompts including both known failure prompts, and that the merge handles confident yes and no, an uncertain signal, unaffected sibling signals, and refinement-only scoping of design ambiguity.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/change/phases/planning.ts", "src/controller/complexity-router.ts", "tests/controller/**"]
  writes: ["src/controller/complexity-inputs.ts", "tests/controller/complexity-inputs.test.ts"]
  requirements: ["judgment-complexity: Uncertain inputs fall back one signal at a time", "judgment-complexity: Design ambiguity applies only in refinement", "judgment-complexity: Classification and overrides are unchanged"]
  scenarios: ["Uncertain signal uses the pattern value", "Other signals are unaffected", "Proposal ignores judged design ambiguity", "Refinement uses judged design ambiguity", "Same inputs classify the same"]
  verify: ["bun test tests/controller/complexity-inputs.test.ts", "bun test tests/controller/complexity-router.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 1.2 Register the `planning.complexity` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts`: four yes/no questions carrying their scoping rules, a yes/no question on whether the change is mechanical, a four-level rubric on how far it reaches, declared effects of adding caution and reducing work, and a gate that maps each of the four answers to true above 0.7, false below 0.3, and abstains otherwise; verify with tests that the migration and public-contract wording states its scoping rules, that replayed responses for the avoid-a-migration and internal-signature prompts produce false inputs, that the recorded-only answers never enter the gate's outcome, and that the effects are declared.

  ```yaml harness-task
  id: "1.2"
  dependsOn: []
  role: builder
  reads: ["src/judgment/**", "src/controller/complexity-router.ts"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "tests/judgment/complexity.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-complexity: Negation and scope are read as written", "judgment-complexity: Additional signals are recorded and never acted on"]
  scenarios: ["Avoided migration answers no", "Internal signature change is not a public contract change", "Recorded-only signals do not change classification"]
  verify: ["bun test tests/judgment/complexity.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Planning Integration

- [x] 2.1 Add an optional judgment runtime to the planning options and call the decision between preflight and classification, declaring the evidence paths, merging confident answers into the four inputs only in enforce mode, keeping the pattern values in shadow mode and for every unavailable reason, reconciling each record with the pattern values, and sending nothing when judgment is disabled; verify in the planning runtime tests that enforce corrects a pattern false positive and a pattern false negative, that shadow and every unavailable reason produce a classification identical to the pattern-only one, that an override is applied unchanged, and that a disabled runtime sends no request and writes no record.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1", "1.2"]
  role: builder
  reads: ["src/change/phases/planning.ts", "src/controller/**", "src/judgment/**", "tests/muster/planning-runtime.test.ts"]
  writes: ["src/change/phases/planning.ts", "tests/muster/planning-runtime.test.ts"]
  requirements: ["judgment-complexity: Risk inputs are judged when confident", "judgment-complexity: Classification and overrides are unchanged", "judgment-complexity: Shadow mode measures agreement without changing classification", "judgment-complexity: Unavailable judgment yields today's classification"]
  scenarios: ["Pattern false positive is corrected", "Pattern false negative is corrected", "Overrides are untouched", "Shadow classification is unchanged", "Every unavailable reason yields the pattern classification", "Disabled judgment adds no work"]
  verify: ["bun test tests/muster/planning-runtime.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Measurement and Documentation

- [x] 3.1 Add a per-signal agreement report in `src/judgment/complexity-report.ts` that reads this decision's records and reports each signal's agreement rate, the direction of disagreement, and the number of changes measured; verify with tests over hand-built records that cover agreement, both directions of disagreement, abstentions excluded from agreement, and unreconciled records excluded.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/judgment/audit.ts", "src/change/phases/planning.ts"]
  writes: ["src/judgment/complexity-report.ts", "tests/judgment/complexity-report.test.ts"]
  requirements: ["judgment-complexity: Shadow mode measures agreement without changing classification"]
  scenarios: ["Agreement is reported per signal"]
  verify: ["bun test tests/judgment/complexity-report.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 3.2 Add the complexity classification row to the per-call-site table in `docs/security.md`, naming the effective request text, the planning phase, and the preflight evidence paths and reasons; verify the documentation checks pass.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["docs/security.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md"]
  requirements: ["judgment-complexity: Request egress is documented"]
  scenarios: ["Security documentation lists the complexity egress"]
  verify: ["bun run docs:check"]
  manual: null
  ```

## 4. Verification

- [x] 4.1 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that classification is unchanged with judgment disabled and that the classifier module is unedited.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.1", "3.2"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-complexity: Classification and overrides are unchanged", "judgment-complexity: Unavailable judgment yields today's classification"]
  scenarios: ["Same inputs classify the same", "Disabled judgment adds no work"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
