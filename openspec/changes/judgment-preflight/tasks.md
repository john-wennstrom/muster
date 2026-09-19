## 1. Retrieval

- [ ] 1.1 Implement candidate retrieval in `src/context/candidates.ts` over the existing Git adapter: identifier and path extraction from the request, search of tracked and non-ignored untracked text files under 2 MiB excluding dependency directories and run logs, ranking by distinct matched terms with path tie-breaking, excerpt windows of at most 600 bytes, a ten-candidate cap, and exclusion of credential-denylist files; verify with tests against a temporary repository that cover determinism across two runs, both caps, and the exclusion of an ignored file, a binary file, an oversized file, a dependency-directory file, and an environment file.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/execution/git.ts", "src/agents/child-broker.ts", "src/judgment/egress.ts", "tests/context/**"]
  writes: ["src/context/candidates.ts", "tests/context/candidates.test.ts"]
  requirements: ["judgment-preflight: Candidates are retrieved by code"]
  scenarios: ["Retrieval is deterministic", "Retrieval is bounded", "Ineligible and credential files are never candidates"]
  verify: ["bun test tests/context/candidates.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Decision and Composition

- [ ] 2.1 Register the `planning.preflight` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts`: a disposition choice, per-candidate questions on whether the candidate already implements the request and whether it would need to change, an ambiguity rubric recorded but not gated, the declared effect of reducing work, and a gate that acts only for proceed at 0.80 or already-satisfied at 0.80 with at least one candidate above 0.7 for implementing, and abstains for needs-clarification at any confidence; verify with tests that each acting and abstaining case behaves as specified, that the per-candidate wording asks about implementing and not about mentioning, and that the question count scales with the candidate count.

  ```yaml harness-task
  id: "2.1"
  dependsOn: []
  role: builder
  reads: ["src/judgment/**", "src/change/phases/planning.ts"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "tests/judgment/preflight.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-preflight: A confident, corroborated already-satisfied blocks without the agent", "judgment-preflight: Clarification always runs the agent", "judgment-preflight: Below the confidence floor the agent runs with the candidates"]
  scenarios: ["Uncorroborated already-satisfied runs the agent", "Confident needs-clarification still runs the agent", "Low confidence runs the agent with candidates"]
  verify: ["bun test tests/judgment/preflight.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Add the pure composer in `src/controller/preflight-composition.ts` that turns the gate's structured outcome into a preflight result of the shape the planning phase already handles: evidence from candidates judged relevant at 0.5 or more, ranked and capped at eight, each with a reason naming the matched terms and probability, a fixed summary sentence per disposition, and the standard already-satisfied blocked-outcome content; verify with tests for ranking, the cap, non-empty reasons and summary as the existing schema requires, and that the already-satisfied composition equals the fields the agent path yields for that disposition.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/change/phases/planning.ts", "src/judgment/gates.ts", "tests/controller/**"]
  writes: ["src/controller/preflight-composition.ts", "tests/controller/preflight-composition.test.ts"]
  requirements: ["judgment-preflight: A confident proceed skips the agent", "judgment-preflight: A confident, corroborated already-satisfied blocks without the agent"]
  scenarios: ["Confident proceed composes evidence", "Evidence is ranked and capped", "Corroborated already-satisfied blocks cheaply"]
  verify: ["bun test tests/controller/preflight-composition.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Integration and Measurement

- [ ] 3.1 Wire preflight in the planning phase: when judgment is enabled, retrieve candidates and declare their paths, ask, and in enforce mode skip the agent and its budget forecast for a confident proceed or corroborated already-satisfied; otherwise forecast and run the agent, appending the candidates to its prompt only when judgment answered and did not act; in shadow mode and for every unavailable reason run the agent with today's prompt; reconcile records with the agent's disposition and evidence paths in shadow mode; mark which path produced the preflight; and perform no retrieval when judgment is disabled; verify in the planning runtime tests each of those paths, that a retrieval or judgment error falls back to the agent, that the fallback prompt equals today's byte for byte, and that a skipped agent leaves the planning budget with judgment spend and no agent spend.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.1", "2.1", "2.2"]
  role: builder
  reads: ["src/change/phases/planning.ts", "src/context/candidates.ts", "src/controller/preflight-composition.ts", "src/judgment/**", "tests/muster/planning-runtime.test.ts"]
  writes: ["src/change/phases/planning.ts", "tests/muster/planning-runtime.test.ts"]
  requirements: ["judgment-preflight: A confident proceed skips the agent", "judgment-preflight: A confident, corroborated already-satisfied blocks without the agent", "judgment-preflight: Below the confidence floor the agent runs with the candidates", "judgment-preflight: Unavailable judgment yields today's preflight", "judgment-preflight: Shadow mode always runs the agent and records agreement", "judgment-preflight: Skipping the agent skips its budget forecast"]
  scenarios: ["Confident proceed composes evidence", "Corroborated already-satisfied blocks cheaply", "Low confidence runs the agent with candidates", "Every unavailable reason runs today's preflight", "Disabled judgment adds no work", "Shadow preflight is unchanged", "Skipped agent consumes no preflight budget"]
  verify: ["bun test tests/muster/planning-runtime.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Add the agreement and precision report in `src/judgment/preflight-report.ts` reading this decision's records: agreement between judged and agent dispositions, the precision of already-satisfied, how often the decision would have acted, and the split by producing path; verify with tests over hand-built records covering agreement, a false already-satisfied, unreconciled records excluded, and an abstention.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/judgment/audit.ts", "src/change/phases/planning.ts"]
  writes: ["src/judgment/preflight-report.ts", "tests/judgment/preflight-report.test.ts"]
  requirements: ["judgment-preflight: Shadow mode always runs the agent and records agreement"]
  scenarios: ["Precision is reported"]
  verify: ["bun test tests/judgment/preflight-report.test.ts", "bun run typecheck"]
  manual: null
  ```

## 4. Documentation and Verification

- [ ] 4.1 Add the planning preflight row to the per-call-site table in `docs/security.md`, naming the request text and the retrieved source excerpts with their paths, and noting the excerpt and candidate caps; verify the documentation checks pass.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.1"]
  role: builder
  reads: ["docs/security.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md"]
  requirements: ["judgment-preflight: Preflight egress is documented"]
  scenarios: ["Security documentation lists the preflight egress"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [ ] 4.2 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that preflight is identical to today's with judgment disabled and that the agent's parsing hardening is unchanged.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["3.2", "4.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-preflight: Unavailable judgment yields today's preflight"]
  scenarios: ["Disabled judgment adds no work"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
