## 1. Failure State and Decision Logic

- [ ] 1.1 Extend the failure state in `src/policies/debugging.ts` with an optional attempted fix on failures, an optional list of assessments in sequence, and an optional early escalation that is valid only below the threshold, at the latest failure, with systematic mode, deriving the mode from the failure count unless an escalation is recorded; verify that every existing debugging test passes unchanged, that a state written before this change validates and behaves as before, that an escalation at or above the threshold is rejected, and that a state claiming systematic mode without an escalation and below the threshold is rejected.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/policies/debugging.ts", "tests/policies/debugging.test.ts"]
  writes: ["src/policies/debugging.ts", "tests/policies/debugging.test.ts"]
  requirements: ["judgment-thrash-detection: Failure state stays valid and backward compatible"]
  scenarios: ["Existing state validates unchanged", "Escalation at or above the threshold is invalid", "Mode without escalation still follows the count"]
  verify: ["bun test tests/policies/debugging.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 1.2 Add the pure functions in `src/policies/repair-progress.ts`: append an assessment to the state, decide the next path from the state and the latest assessment as continue, escalate, or await the user with precedence to awaiting the user, and apply an early escalation only when two consecutive assessments were each stalled at a same-root-cause probability above 0.8 and a progress probability below 0.3 and the threshold has not been reached; verify with tests for two stalled rounds, one stalled round, a stalled round followed by progress, a human-needed assessment taking precedence, and a property test over generated failure histories and answer sequences showing the attempt at which the mode becomes systematic is never later than the count-based attempt and the threshold is never raised.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/policies/debugging.ts", "tests/policies/**"]
  writes: ["src/policies/repair-progress.ts", "tests/policies/repair-progress.test.ts"]
  requirements: ["judgment-thrash-detection: Judgment can only shorten a repair loop", "judgment-thrash-detection: Repeated failure without progress escalates early", "judgment-thrash-detection: A failure that needs a human stops the loop"]
  scenarios: ["Escalation is never later than the threshold", "Threshold is never raised", "Two stalled rounds escalate early", "One stalled round does not escalate", "Progress prevents escalation", "Human-needed failure stops further attempts"]
  verify: ["bun test tests/policies/repair-progress.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Decision and Assessment

- [ ] 2.1 Register the `debugging.thrash` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts` and add the asynchronous assessment step in `src/policies/repair-progress.ts`: yes/no questions on same root cause, changed failure, progress, defect located, and human involvement, a rubric on how well the fix matched the evidence with the last three recorded but not gated, declared effects of reducing work and adding caution, an assessment made only with at least two failures and an attempted fix on the latest, a state built from the latest two failures' bounded evidence and reproductions with the attempted fix and the task definition, assessments stored in both modes and an escalation recorded only in enforce mode, and every unavailable reason and disabled judgment leaving transitions to the count; verify with tests for both non-assessment cases, both modes, every unavailable reason, redaction of a bearer credential in evidence, excerpting of long evidence, the reconciliation of a shadow decision with the task's eventual outcome, and that disabled judgment sends nothing.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1", "1.2"]
  role: builder
  reads: ["src/judgment/**", "src/policies/**", "tests/policies/**"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "src/policies/repair-progress.ts", "tests/judgment/thrash-detection.test.ts", "tests/policies/repair-progress-judgment.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-thrash-detection: Assessment needs two failures and an attempted fix", "judgment-thrash-detection: Unavailable judgment yields counting", "judgment-thrash-detection: Shadow mode records what it would have done", "judgment-thrash-detection: Failure text is redacted and bounded"]
  scenarios: ["First failure is not assessed", "Failure without an attempted fix is not assessed", "Every unavailable reason leaves transitions to the count", "Disabled judgment adds no work", "Shadow transitions follow the count", "Outcome is recorded against the shadow decision", "Secrets in failure output are redacted", "Long failure output is excerpted"]
  verify: ["bun test tests/judgment/thrash-detection.test.ts", "bun test tests/policies/repair-progress-judgment.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Documentation and Verification

- [ ] 3.1 Add the repair progress assessment row to the per-call-site table in `docs/security.md`, naming the latest two failures' evidence and reproductions, the attempted fix, and the task definition, and noting that evidence may contain command output; verify the documentation checks pass.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["docs/security.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md"]
  requirements: ["judgment-thrash-detection: Thrash egress is documented"]
  scenarios: ["Security documentation lists the thrash egress"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [ ] 3.2 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that every existing debugging state and transition is unchanged with judgment disabled and that the property test over failure histories passes.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["3.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-thrash-detection: Judgment can only shorten a repair loop", "judgment-thrash-detection: Unavailable judgment yields counting"]
  scenarios: ["Escalation is never later than the threshold", "Disabled judgment adds no work"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
