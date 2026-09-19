## 1. Retention and Diff

- [ ] 1.1 Implement snapshot retention in `src/review/review-snapshot.ts` over the atomic store under the change's run identifier: save the artifact digest, a digest for every reviewed file, and the text of only the proposal and the design, load a snapshot by digest, and prune to the three most recent on save; verify with tests that a round trip preserves digests and the two texts, that no other file's text is stored, that pruning keeps the three most recent, and that a missing snapshot loads as absent without raising.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/persistence/**", "src/review/artifact-digest.ts", "tests/review/**"]
  writes: ["src/review/review-snapshot.ts", "tests/review/review-snapshot.test.ts"]
  requirements: ["judgment-review-triage: Reviewed prose is retained when triage is enabled"]
  scenarios: ["Snapshots are pruned"]
  verify: ["bun test tests/review/review-snapshot.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 1.2 Implement the pure line-based unified diff in `src/review/text-diff.ts` with five lines of context, deterministic output, and an empty result for identical texts; verify with tests over additions, removals, replacements, identical inputs, and a large input, and that a diff of two prose files, concatenated with a total cap of 16,000 bytes, reports that the cap was exceeded instead of truncating.

  ```yaml harness-task
  id: "1.2"
  dependsOn: []
  role: builder
  reads: ["tests/review/**"]
  writes: ["src/review/text-diff.ts", "tests/review/text-diff.test.ts"]
  requirements: ["judgment-review-triage: Only the diff of prose leaves the machine"]
  scenarios: ["State holds only prose diffs"]
  verify: ["bun test tests/review/text-diff.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. Review Artifact

- [ ] 2.1 Add optional carry-forward marks to the review artifact in `src/review/review-artifact.ts`: the basis digest, the running count, the decision record, and an evidence section listing the judged answers, rendered as optional metadata lines and an optional section, read through optional readers, with verdict, digest, and list handling unchanged; verify with tests that a carried-forward artifact round-trips, that an artifact written before this change parses as a full review, and that every existing artifact test passes unchanged.

  ```yaml harness-task
  id: "2.1"
  dependsOn: []
  role: builder
  reads: ["src/review/review-artifact.ts", "tests/review/artifact.test.ts"]
  writes: ["src/review/review-artifact.ts", "tests/review/artifact.test.ts"]
  requirements: ["judgment-review-triage: Review artifacts stay compatible"]
  scenarios: ["Earlier review artifact still parses", "Carried-forward artifact round-trips"]
  verify: ["bun test tests/review/artifact.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Decision and Controller

- [ ] 3.1 Implement the pure eligibility function in `src/review/review-triage.ts` that compares the current artifacts with the retained copy and the existing review and returns either the reason for ineligibility or the changed prose files: the previous review must approve, a retained copy must exist, only the proposal and design may differ with no specification or task-list file changed, added, or removed, fewer than three consecutive carry-forwards may have been made, and no additional instructions may have been given; verify with a table of cases covering each condition failing alone and the eligible case.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/review/review-snapshot.ts", "src/review/review-artifact.ts", "src/review/artifact-digest.ts"]
  writes: ["src/review/review-triage.ts", "tests/review/review-triage.test.ts"]
  requirements: ["judgment-review-triage: Only immaterial prose edits of an approved review are eligible"]
  scenarios: ["Spec edit gets a full review", "Task list edit gets a full review", "Previous REVISE is never carried forward", "Missing snapshot gets a full review", "Fourth consecutive edit gets a full review", "Review with instructions gets a full review"]
  verify: ["bun test tests/review/review-triage.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Register the `review.triage` decision in `src/judgment/questions.ts` and `src/judgment/gates.ts` with its own enabling flag `MUSTER_JEV_REVIEW_TRIAGE`, a four-level materiality rubric, yes/no questions on requirement, scenario, task, and scope changes and on contradicting the approval, a declared effect of reducing work, and a gate that carries forward only when materiality is below 1.5 at confidence 0.85 and every yes/no probability is below 0.25, and add the state builder in `src/review/review-triage.ts` from the prose diffs and the previous recommendations; verify with tests that each threshold behaves as specified, that the enabling flag is required, and that the state holds only the two diffs and the recommendations.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["1.2"]
  role: builder
  reads: ["src/judgment/**", "src/review/text-diff.ts", "src/review/review-triage.ts"]
  writes: ["src/judgment/questions.ts", "src/judgment/gates.ts", "src/review/review-triage.ts", "tests/judgment/review-triage.test.ts", "tests/fixtures/judgment/**"]
  requirements: ["judgment-review-triage: Carry-forward requires an immaterial, confident, non-contradicting answer", "judgment-review-triage: Triage is off unless explicitly enabled"]
  scenarios: ["Wording-only edit is carried forward", "Added requirement text is not carried forward", "Uncertain materiality gets a full review", "Judgment enabled without the triage flag means full review"]
  verify: ["bun test tests/judgment/review-triage.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.3 Integrate triage into `reviewChange` in `src/controller/review.ts` through optional dependencies: when enabled and eligible, judge the edit and in enforce mode persist a carried-forward artifact for the current digest with the round incremented, the basis reviewer's model, the preserved recommendations, and the marks, recheck the digest after judgment and fall back to a full review on any change, doubt, unavailable reason, or error, retain a snapshot after an approving full review only when triage is enabled, reset the count on every full review, and in shadow mode always dispatch the reviewer and reconcile the record with its verdict and required changes; verify in the controller tests each of those paths, that no reviewer is dispatched for a carry-forward, that no request is sent for an ineligible edit, that nothing is retained when triage is off, and that every existing review controller test passes unchanged.

  ```yaml harness-task
  id: "3.3"
  dependsOn: ["2.1", "3.1", "3.2"]
  role: builder
  reads: ["src/controller/review.ts", "src/review/**", "src/judgment/**", "tests/commands/review.test.ts", "tests/review/**"]
  writes: ["src/controller/review.ts", "tests/controller/review-triage.test.ts"]
  requirements: ["judgment-review-triage: Triage is off unless explicitly enabled", "judgment-review-triage: A carried-forward review is recorded honestly", "judgment-review-triage: A full review resets the count", "judgment-review-triage: Reviewed prose is retained when triage is enabled", "judgment-review-triage: Any doubt or failure means a full review", "judgment-review-triage: Shadow mode always reviews and measures"]
  scenarios: ["No flag means full review", "Carry-forward record names its basis and evidence", "Full review after carry-forwards resets the count", "Approved review retains a snapshot", "Nothing is retained when triage is off", "Every unavailable reason gives a full review", "Artifacts changing during triage gives a full review", "Shadow review is unchanged"]
  verify: ["bun test tests/controller/review-triage.test.ts", "bun test tests/commands/review.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.4 Wire the review phase in `src/change/phases/review.ts`: build the judgment runtime and the triage dependencies only when the flag is set, and state in the outcome when a review was carried forward, from which basis, how many times, and how to obtain a full review; verify with a lifecycle test that deriving the change state after a carry-forward treats the review as an approval of the current artifact digest exactly as an ordinary approval, and that the outcome names the basis and count.

  ```yaml harness-task
  id: "3.4"
  dependsOn: ["3.3"]
  role: builder
  reads: ["src/change/phases/review.ts", "src/change/snapshot.ts", "src/controller/change-snapshot.ts", "tests/muster/**"]
  writes: ["src/change/phases/review.ts", "tests/muster/review-triage-lifecycle.test.ts"]
  requirements: ["judgment-review-triage: A carried-forward review is recorded honestly"]
  scenarios: ["Lifecycle treats a carried-forward approval as current"]
  verify: ["bun test tests/muster/review-triage-lifecycle.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.5 Add the false-skip report in `src/judgment/review-triage-report.ts` that reads this decision's records and gives the number of eligible edits, how many would have been carried forward, and how many of those were followed by a review that did not approve; verify with tests over hand-built records covering a false skip, an agreeing skip, an abstention, and unreconciled records excluded.

  ```yaml harness-task
  id: "3.5"
  dependsOn: ["3.3"]
  role: builder
  reads: ["src/judgment/audit.ts", "src/controller/review.ts"]
  writes: ["src/judgment/review-triage-report.ts", "tests/judgment/review-triage-report.test.ts"]
  requirements: ["judgment-review-triage: Shadow mode always reviews and measures"]
  scenarios: ["False skips are reported"]
  verify: ["bun test tests/judgment/review-triage-report.test.ts", "bun run typecheck"]
  manual: null
  ```

## 4. Documentation and Verification

- [ ] 4.1 Add the review triage row to the per-call-site table in `docs/security.md`, naming the proposal and design diffs and the previous review's recommendations and the `MUSTER_JEV_REVIEW_TRIAGE` flag; verify the documentation checks pass.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.4"]
  role: builder
  reads: ["docs/security.md", "scripts/docs/check.ts"]
  writes: ["docs/security.md"]
  requirements: ["judgment-review-triage: Triage egress is documented"]
  scenarios: ["Security documentation lists the triage egress"]
  verify: ["bun run docs:check"]
  manual: null
  ```

- [ ] 4.2 Run the full validation set and compare pass and fail counts against the recorded pre-existing platform baseline, confirming that every changed artifact set gets a full review exactly as today when the flag is unset and that a specification edit is never carried forward.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["3.5", "4.1"]
  role: validator
  reads: ["src/**", "tests/**", "docs/**"]
  writes: []
  requirements: ["judgment-review-triage: Triage is off unless explicitly enabled", "judgment-review-triage: Only immaterial prose edits of an approved review are eligible"]
  scenarios: ["No flag means full review", "Spec edit gets a full review"]
  verify: ["bun run typecheck", "bun run ci:test", "bun run docs:check"]
  manual: null
  ```
