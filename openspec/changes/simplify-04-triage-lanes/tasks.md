## 1. The lane module

- [ ] 1.1 Create `src/controller/lane.ts` exporting the `Lane` type (`small`, `medium`, `large`), the declared `LANE_POLICY` table (`specialistOpinions`, `debate`, `reducesWorkAllowed` per lane, with small and medium at 0, false, true and large at 2, true, false), the pure `chooseLane` function, and the lane record functions. `chooseLane` takes the pattern classification (from `classifyChange` over candidate paths and the pattern risk inputs), the judged answers (confident risk booleans, mechanical, reach level), the phase and an optional user choice, and returns the lane, source (`user`, `judgment` or `pattern`) and reasons. Rules: a user choice wins; the pattern lane is direct and bounded giving medium and architectural giving large; confident risk answers merge one input at a time using the existing `mergeRiskInputs`; small only when the merged classification is direct, all four risks were judged and are no, and reach was confidently in the lowest two levels; otherwise the lane stays where merging put it. Record functions `readLane`, `writeLane` and `escalateLane` persist `lane.json` (`schemaVersion`, `lane`, `source`, `reasons`, `escalations`, `decidedAt`) under the change's run store using the existing atomic JSON store; `readLane` returns medium with source `pattern` when no file exists, and `escalateLane` refuses a move that is not strictly upward. Add tests for every rule, the missing-file default, escalation and refused downgrade.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/controller/**", "src/persistence/**", "tests/controller/**"]
  writes: ["src/controller/lane.ts", "tests/controller/lane.test.ts"]
  requirements: ["change-lanes: Every change has exactly one lane", "change-lanes: Lanes only escalate", "change-lanes: Lane policy is one declared table", "change-triage: Small requires confident evidence for everything", "change-triage: A confident risk answer raises the lane", "change-triage: Pattern classification is the floor"]
  scenarios: ["Planning records the lane", "A change planned before lanes existed", "Escalation is recorded", "A downgrade is refused", "Large adds opinions and a debate", "Small and medium run no optional stages", "Large never permits work reduction", "Every condition holds", "One risk is uncertain", "Patterns alone never give small", "A confident migration answer raises the lane", "Ambiguity is ignored in a proposal", "An uncertain answer keeps the pattern value"]
  verify: ["bun test tests/controller/lane.test.ts", "bun run typecheck"]
  manual: null
  ```

## 2. The triage decision

- [ ] 2.1 Create `src/judgment/decisions/change-triage.ts` and `prompts/judgment/change.triage.yaml`. The decision id is `change.triage`, version 1, effects `adds_caution` and `reduces_work`. Its input is the request text, the phase and the candidates (path, excerpt). Its questions are the union of the two decisions it replaces, copied from their existing question files without rewording: the `disposition` choice, the two per-candidate questions (implements, needs change), the four risk questions, `mechanical` and `reach`. Its state builder is the union of the two existing state builders. Its gate returns `{ disposition, candidates (index and relevance), risks (only confident answers), mechanical, reach }`, applying the existing preflight confidence floors for the disposition (proceed acts at the floor; already-satisfied acts only when corroborated by a candidate at the corroboration floor; needs-clarification never acts) and the existing complexity bands for the risk answers. Register it in the catalog. Add tests with the scripted client for each disposition, corroboration, uncertain risk answers, and the reach rubric. Add its golden under `tests/prompts/golden/judgment/`.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/judgment/**", "prompts/judgment/**", "tests/judgment/**", "tests/prompts/**"]
  writes: ["src/judgment/decisions/change-triage.ts", "src/judgment/catalog.ts", "prompts/judgment/change.triage.yaml", "tests/judgment/change-triage.test.ts", "tests/prompts/golden/judgment/**"]
  requirements: ["change-triage: One request answers disposition, risk and reach", "change-triage: A confident proceed skips the agent", "change-triage: A confident, corroborated already-satisfied blocks without the agent", "change-triage: Clarification always runs the agent", "change-triage: Negation and scope are read as written", "change-triage: A confident risk answer raises the lane"]
  scenarios: ["One request per invocation", "Refinement includes the previous review's required changes", "Confident proceed", "Corroborated already-satisfied", "Uncorroborated already-satisfied", "Clarification at high confidence", "A request that avoids a migration"]
  verify: ["bun test tests/judgment/change-triage.test.ts", "bun test tests/prompts", "bun run typecheck"]
  manual: null
  ```

## 3. Wire the front of planning

- [ ] 3.1 Parse the lane option in the propose and refine handlers: accept `--lane <small|medium|large>` anywhere among the argument words, remove it from the prompt text, validate the value, and on an invalid value return a blocked outcome with the usage line without starting any agent or judgment request. Update the usage strings in `src/change/commands.ts` and `src/change/parse.ts` to `/change propose <change> [--lane small|medium|large] <goal>` and the refine equivalent, and pass the parsed lane into the planning phase options. Add handler tests for valid, invalid and absent values.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/change/**", "tests/**"]
  writes: ["src/change/handlers/propose.ts", "src/change/handlers/refine.ts", "src/change/commands.ts", "src/change/parse.ts", "tests/muster/lane-option.test.ts"]
  requirements: ["change-lanes: The user may choose the lane"]
  scenarios: ["An explicit lane overrides triage", "An invalid lane is rejected"]
  verify: ["bun test tests/muster/lane-option.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 3.2 Rework the front half of `runProductionPlanning` in `src/change/phases/planning.ts`. New order: retrieve candidates by code (whether or not judgment is enabled); unless a user lane was given, ask `change.triage` once through `tryJudge`; call `chooseLane` using the pattern classification over candidate paths; write `lane.json` before any agent starts; then handle disposition. A confident enforce-mode proceed composes the preflight result by code (reuse `composePreflight`, adapted to the triage gate value) and skips the preflight agent and its budget forecast; a corroborated already-satisfied blocks without the agent; anything else runs the existing preflight agent, listing the candidates in its prompt in enforce mode only. Replace `resolveRiskInputs`, `judgePreflight` and the `orchestrationPolicy` call: `classifyChange` takes candidate paths instead of agent evidence paths, and specialist opinions and debate come from `LANE_POLICY[lane]` (still subject to the optional budget forecast). In shadow mode use the pattern lane and record the lane enforce would have chosen; after synthesis, reconcile the triage record with the agent's disposition and whether the lane held. Keep every other behavior, including budget handling, artifact writing and outcomes.

  ```yaml harness-task
  id: "3.2"
  dependsOn: ["2.1", "3.1"]
  role: builder
  reads: ["src/**", "tests/**", "prompts/**"]
  writes: ["src/change/phases/planning.ts", "src/controller/planning.ts", "src/controller/complexity-router.ts", "src/controller/preflight-composition.ts", "src/context/candidates.ts", "tests/muster/planning-runtime.test.ts", "tests/controller/**", "tests/context/**"]
  requirements: ["change-lanes: No agent session is needed to choose a lane", "change-lanes: The user may choose the lane", "change-lanes: Lane policy is one declared table", "change-triage: One request answers disposition, risk and reach", "change-triage: Candidates are retrieved by code", "change-triage: Below the confidence floor the agent runs with the candidates", "change-triage: Shadow mode uses the pattern lane and records the alternative", "change-triage: Unavailable triage yields the pattern lane"]
  scenarios: ["Lane precedes the first agent", "An explicit lane overrides triage", "Large adds opinions and a debate", "Small and medium run no optional stages", "One request per invocation", "Candidates are bounded and filtered", "Retrieval runs without judgment", "Uncertain disposition in enforce mode", "Shadow triage", "Service unreachable"]
  verify: ["bun test tests/muster/planning-runtime.test.ts", "bun test tests/controller", "bun test tests/context", "bun run typecheck"]
  manual: null
  ```

## 4. Remove the superseded decisions

- [ ] 4.1 Delete the `planning.preflight` and `planning.complexity` decision modules, their question files, their tests, their goldens, the `orchestrationPolicy` function and its tests, and their catalog entries. Keep `classifyChange`, `patternRiskInputs`, `mergeRiskInputs` and `composePreflight`. Search for and remove any remaining import or mention. Update the exclusion and allowlist files if they name these decisions.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["3.2"]
  role: builder
  reads: ["src/**", "tests/**", "prompts/**"]
  writes: ["src/judgment/**", "src/controller/**", "prompts/judgment/**", "tests/judgment/**", "tests/controller/**", "tests/prompts/**", "tests/layering/**"]
  requirements: ["change-triage: One request answers disposition, risk and reach"]
  scenarios: ["One request per invocation"]
  verify: ["bun test tests/judgment", "bun test tests/controller", "bun test tests/prompts", "bun test tests/layering", "bun run typecheck"]
  manual: null
  ```

## 5. Show the lane

- [ ] 5.1 Add the lane to `ChangeSnapshot` (loaded through `readLane`, defaulting to medium) and print `Lane: <lane> (<source>), <n> escalation(s)` in `renderChangeStatus`. Update the production snapshot loader in `src/change/snapshot.ts`. Add tests for a judged lane with one escalation, a user lane and a change with no lane record.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["1.1", "3.2"]
  role: builder
  reads: ["src/change/**", "src/controller/**", "tests/**"]
  writes: ["src/controller/change-snapshot.ts", "src/change/snapshot.ts", "src/change/outcome.ts", "tests/controller/**", "tests/muster/**"]
  requirements: ["change-lanes: The lane is visible", "change-lanes: Every change has exactly one lane"]
  scenarios: ["Status shows the lane", "A change planned before lanes existed"]
  verify: ["bun test tests/controller", "bun test tests/muster", "bun run typecheck"]
  manual: null
  ```

## 6. Documentation

- [ ] 6.1 Update the call-site table in `docs/security.md`: remove the `planning.complexity` and `planning.preflight` rows and add one `change.triage` row stating that it sends, once per propose or refine without an explicit lane, the effective request text (including the previous review's required changes on refinement), the phase, and up to ten candidate files retrieved by code with path and an excerpt of at most 600 bytes, that it is the largest planning egress, and which files are never candidates. Update the README's planning cost section to mention lanes and `--lane`. Run `bun run docs:check`.

  ```yaml harness-task
  id: "6.1"
  dependsOn: ["4.1", "5.1"]
  role: builder
  reads: ["docs/**", "README.md"]
  writes: ["docs/security.md", "README.md"]
  requirements: ["change-triage: Triage egress is documented"]
  scenarios: ["One row replaces two"]
  verify: ["bun run docs:check"]
  manual: null
  ```
