## 1. Capsule Assembly and Escalation

- [x] 1.1 Extend `src/context/assembler.ts` with an optional ranking input, an optional path on slices, ranking-ordered packing by score times confidence with list-order ties, demotion of slices below 0.5 at confidence 0.7, unranked slices after ranked ones, and an oversized-required list and stored ranking on the capsule, keeping the assembler pure and synchronous; verify that every existing assembler test still passes, that a property test over random inputs shows the capsule without a ranking equals the previous output, that the budget is never exceeded with any ranking, and that ordering, demotion, low-confidence non-demotion, unscored ordering, oversized-required listing, and the genuine required-over-budget failure each behave as specified.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/context/**", "tests/context/**"]
  writes: ["src/context/assembler.ts", "tests/context/assembler.test.ts", "tests/context/assembler-ranking.test.ts"]
  requirements: ["judgment-capsule-ranking: Relevant slices are packed by necessity", "judgment-capsule-ranking: Confidently unnecessary slices are demoted", "judgment-capsule-ranking: Uncertain and unscored slices keep today's treatment", "judgment-capsule-ranking: Without a ranking the capsule is unchanged", "judgment-capsule-ranking: A required slice that does not fit is reported, not fatal"]
  scenarios: ["Higher-ranked slice is packed first", "Budget is never exceeded", "Required content is unchanged", "Unrelated slice is demoted despite spare budget", "Low-confidence slice is not demoted", "Unscored slices follow scored slices in list order", "No ranking gives today's capsule", "Oversized required slice is listed", "Genuinely required content still fails when over budget"]
  verify: ["bun test tests/context", "bun run typecheck"]
  manual: null
  ```

- [x] 1.2 Add an authorization helper to `src/context/escalation.ts` that builds the authorization callback from a capsule's stored ranking, approving only slices ranked at least 1.5 with confidence at least 0.6 and leaving every existing refusal check ahead of it; verify with tests that a ranked available slice is authorized, that an excluded slice scored required is refused, that an unknown or over-budget request is refused before the ranking is consulted, and that an unranked slice is not authorized by ranking.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/context/**", "tests/context/**"]
  writes: ["src/context/escalation.ts", "tests/context/escalation.test.ts"]
  requirements: ["judgment-capsule-ranking: Ranking-based authorization stays inside the available set"]
  scenarios: ["Ranked available slice is authorized", "Excluded slice is refused regardless of ranking", "Unranked slice is not authorized by ranking"]
  verify: ["bun test tests/context/escalation.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Decision and Ranking Step

- [x] 2.1 Register the `context.capsule_ranking` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts`: one necessity question per slice on a four-level rubric of unrelated, background, useful, and required whose wording says necessity means needed to do the work, declared effects of reducing work and adding advice, and a gate that returns the ranking for every scored slice; verify with tests that the wording states the distinction and names the four levels, that the question count matches the slice count, and that the effects are declared.

  ```yaml harness-task
  id: "2.1"
  dependsOn: []
  role: builder
  reads: ["src/judgment/**", "src/context/assembler.ts"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "tests/judgment/capsule-ranking.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-capsule-ranking: Necessity means needed to do the work"]
  scenarios: ["Question distinguishes necessary from related"]
  verify: ["bun test tests/judgment/capsule-ranking.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 2.2 Implement the ranking step in `src/context/ranking.ts`: build the state from the task contract and at most thirty slice excerpts of at most 600 bytes, declare slice paths, call the decision, return the ranking in enforce mode and nothing to act on in shadow mode or when unavailable, assemble both capsules in shadow mode to record which slices would be included, demoted, and listed as oversized, and add a helper that reconciles a record with the slice identifiers later escalated; verify with tests that enforce returns a ranking, that shadow returns nothing and records the counterfactual, that every unavailable reason yields the unranked capsule, that slices beyond thirty are unscored, that disabled judgment sends nothing, and that escalations reconcile with the counterfactual.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["1.1", "2.1"]
  role: builder
  reads: ["src/context/**", "src/judgment/**", "tests/context/**"]
  writes: ["src/context/ranking.ts", "tests/context/ranking.test.ts"]
  requirements: ["judgment-capsule-ranking: Shadow mode packs as today and records the counterfactual", "judgment-capsule-ranking: Ranking state is bounded", "judgment-capsule-ranking: Unavailable ranking yields today's capsule"]
  scenarios: ["Shadow capsule is unchanged", "Escalations are reconciled with the counterfactual", "Slices beyond the cap are unscored", "Every unavailable reason yields the unranked capsule", "Disabled judgment adds no work"]
  verify: ["bun test tests/context/ranking.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Documentation and Verification

- [x] 3.1 Add the context capsule ranking row to the per-call-site table in `docs/security.md`, naming the task contract and slice excerpts and how file-backed slices are identified for the credential denylist, and add a note under the context item in `docs/roadmap.md` naming the call sequence of the ranking step then the assembler for the future wiring; verify the documentation checks pass.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.2"]
  role: builder
  reads: ["docs/security.md", "docs/roadmap.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md", "docs/roadmap.md"]
  requirements: ["judgment-capsule-ranking: Slice egress is documented"]
  scenarios: ["Security documentation lists the ranking egress"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [x] 3.2 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that capsules are identical to the previous output when no ranking is supplied and that judgment disabled performs no work.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["1.2", "3.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-capsule-ranking: Without a ranking the capsule is unchanged", "judgment-capsule-ranking: Unavailable ranking yields today's capsule"]
  scenarios: ["No ranking gives today's capsule", "Disabled judgment adds no work"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
