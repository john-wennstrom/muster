## 1. Candidates and Decision

- [x] 1.1 Implement the candidate parser in `src/review/review-extraction.ts`: list items with joined continuation lines and standalone paragraphs, each carrying its nearest heading, with list markers removed, whitespace normalized to a single line, at most 60 candidates of at most 400 characters, and a result that marks extraction as skipped when a limit is exceeded; verify with tests over bulleted, numbered, wrapped, headed, and paragraph-form responses, an empty response, and both limits, and that every candidate equals a line of the input after marker removal and normalization.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/review/planning-reviewer.ts", "src/review/review-artifact.ts", "tests/review/**"]
  writes: ["src/review/review-extraction.ts", "tests/review/review-extraction.test.ts"]
  requirements: ["judgment-review-extraction: Extracted findings are the reviewer's own words"]
  scenarios: ["Findings are verbatim lines", "Too many candidates skips extraction"]
  verify: ["bun test tests/review/review-extraction.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 1.2 Register the `review.extraction` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts` and add the pure assembly in `src/review/review-extraction.ts`: a verdict choice among approve, revise, and unclear, a per-candidate choice among critical, required, recommendation, and not a finding, a declared effect of reducing work, and acceptance only when the verdict is at least 0.8 and not unclear, every line is at least 0.8, and the verdict is consistent with the lines in both directions, assembling the submission from verbatim candidate lines; verify with a table of answer sets covering acceptance, an uncertain line, an approval with a blocking line, a revise without a blocking line, and an unclear or uncertain verdict, and that the assembled submission passes the existing submission schema.

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/judgment/**", "src/review/review-artifact.ts", "src/review/review-extraction.ts"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "src/review/review-extraction.ts", "tests/judgment/review-extraction.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-review-extraction: Extraction is accepted only when confident and consistent"]
  scenarios: ["Confident consistent extraction is accepted", "Uncertain line rejects extraction", "Approve with a blocking line is rejected", "Revise without a blocking line is rejected", "Unclear verdict is rejected"]
  verify: ["bun test tests/judgment/review-extraction.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Review Artifact Provenance

- [x] 2.1 Add an optional extraction mark naming the decision record to the review artifact in `src/review/review-artifact.ts`, with rendering as one optional metadata line, reading through an optional-line reader, and unchanged verdict, digest, and list handling; verify with tests that a marked artifact round-trips, that an artifact written before this change parses as not extracted, and that every existing artifact test passes unchanged.

  ```yaml harness-task
  id: "2.1"
  dependsOn: []
  role: builder
  reads: ["src/review/review-artifact.ts", "tests/review/artifact.test.ts"]
  writes: ["src/review/review-artifact.ts", "tests/review/artifact.test.ts"]
  requirements: ["judgment-review-extraction: Extracted reviews are marked"]
  scenarios: ["Extracted review carries its provenance", "Review without the marker still parses"]
  verify: ["bun test tests/review/artifact.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Integration and Measurement

- [x] 3.1 Wire extraction into `runBrokeredPlanningReviewer` in `src/review/planning-reviewer.ts` through an optional judgment runtime on the reviewer request: on a response that is not valid structured output and has candidate lines, attempt an extraction before the corrective retry and before the final failure, return an accepted extraction with a marker in enforce mode, send the unchanged retry when not accepted or unavailable, never judge a valid or schema-rejected response or an empty one, and in shadow mode send the retry and reconcile the record with its verdict and blocking count; verify in the reviewer tests each of those paths, that the retry message, session, attempt limit, and final error are identical to the current ones when judgment does not act, and that disabled judgment sends nothing.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/review/planning-reviewer.ts", "src/review/review-extraction.ts", "src/judgment/**", "tests/review/reviewer.test.ts"]
  writes: ["src/review/planning-reviewer.ts", "tests/review/reviewer.test.ts"]
  requirements: ["judgment-review-extraction: Extraction is attempted before a corrective retry", "judgment-review-extraction: An unaccepted extraction retries exactly as today", "judgment-review-extraction: Empty responses cannot be extracted", "judgment-review-extraction: Shadow mode extracts and compares without acting", "judgment-review-extraction: Unavailable judgment yields today's behavior"]
  scenarios: ["Unparseable response is extracted before retrying", "Valid structured response is never judged", "Final attempt tries extraction before failing", "Unaccepted extraction retries as today", "Empty response is retried", "Shadow extraction never replaces the retry", "Every unavailable reason retries as today", "Disabled judgment adds no work"]
  verify: ["bun test tests/review/reviewer.test.ts", "bun run typecheck"]
  manual: null
  ```

- [x] 3.2 Thread the optional judgment runtime and the extraction marker through `dispatchPlanningReview` in `src/review/planning-reviewer.ts`, `reviewChange` in `src/controller/review.ts`, and the review phase, writing the mark into the persisted review artifact; verify with review command tests that an accepted extraction is persisted with its mark, that the reviewer's tool use is still audited and a non-read-only tool still fails the review, that the assembled review passes the same validation, and that the existing review command tests pass unchanged.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["2.1", "3.1"]
  role: builder
  reads: ["src/review/planning-reviewer.ts", "src/controller/review.ts", "src/change/phases/review.ts", "tests/commands/review.test.ts"]
  writes: ["src/review/planning-reviewer.ts", "src/controller/review.ts", "src/change/phases/review.ts", "tests/commands/review.test.ts"]
  requirements: ["judgment-review-extraction: Reviewer audits are unchanged", "judgment-review-extraction: Extracted reviews are marked"]
  scenarios: ["Extracted review is audited and validated like any other", "Extracted review carries its provenance"]
  verify: ["bun test tests/commands/review.test.ts", "bun test tests/review", "bun run typecheck"]
  manual: null
  ```

- [x] 3.3 Build the fixture corpus of recorded reviewer responses with their expected structure under `tests/fixtures/judgment/` and add the agreement report in `src/judgment/review-extraction-report.ts`, giving the rate at which extraction would have been accepted and the rate at which its verdict agreed with the retry's; verify that a corpus test replays every response through the candidate parser, the decision, and the assembly and matches the expected structure, and that the report is correct over hand-built records including unreconciled ones.

  ```yaml harness-task
  id: "3.3"
  dependsOn: ["3.1"]
  role: builder
  reads: ["src/review/review-extraction.ts", "src/judgment/audit.ts", "tests/fixtures/judgment/**"]
  writes: ["src/judgment/review-extraction-report.ts", "tests/judgment/review-extraction-report.test.ts", "tests/judgment/review-extraction-corpus.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-review-extraction: Shadow mode extracts and compares without acting"]
  scenarios: ["Agreement is reported"]
  verify: ["bun test tests/judgment/review-extraction-report.test.ts", "bun test tests/judgment/review-extraction-corpus.test.ts", "bun run typecheck"]
  manual: null
  ```

## 4. Documentation and Verification

- [x] 4.1 Add the review extraction row to the per-call-site table in `docs/security.md`, naming the reviewer's response text and its candidate lines; verify the documentation checks pass.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.2"]
  role: builder
  reads: ["docs/security.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md"]
  requirements: ["judgment-review-extraction: Extraction egress is documented"]
  scenarios: ["Security documentation lists the extraction egress"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [x] 4.2 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that the reviewer runner is identical to today's with judgment disabled and that existing review artifacts still parse.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["3.3", "4.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-review-extraction: Unavailable judgment yields today's behavior"]
  scenarios: ["Disabled judgment adds no work"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
