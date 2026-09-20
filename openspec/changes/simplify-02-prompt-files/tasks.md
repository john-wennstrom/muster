## 1. Capture goldens before anything moves

- [ ] 1.1 Add `tests/prompts/capture.ts`, a Bun script that renders, from fixed sample inputs, every agent prompt the pipeline sends (exploration, planning preflight, planning opinion, planning debate, planning synthesis with and without a prior rejection, planning review, builder, task review) by calling the current in-code builders, and writes each result to `tests/prompts/golden/agents/<name>.txt`. In the same script, for every decision in the judgment catalog, build its questions from its representative input (and, for decisions whose questions depend on input, from a fixed three-item input), and write the canonical JSON that `questionsFingerprint` hashes to `tests/prompts/golden/judgment/<decision-id>.json`. Run the script and commit its output. Add `tests/prompts/golden.test.ts` that re-renders through the current code and compares to the goldens, so the suite passes before any migration. Search `src/` for every other place a prompt string is passed to an agent (for example a corrective retry or rejection message) and include it; list any you find in a comment at the top of the capture script.

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/**", "tests/**"]
  writes: ["tests/prompts/**"]
  requirements: ["prompt-templates: Moving wording preserves it exactly"]
  scenarios: ["Agent prompts match their goldens", "Questions match their fingerprints"]
  verify: ["bun test tests/prompts", "bun run typecheck"]
  manual: null
  ```

## 2. Renderer and question loader

- [ ] 2.1 Create `src/prompts/render.ts`. A Markdown template starts with a front-matter block `variables: [A, B]`. `renderPrompt(name, variables)` loads `prompts/agents/<name>.md` (cached, resolved relative to the package root using the module's own location, never the working directory) and returns a branded `RenderedPrompt` string. It replaces `{{NAME}}` placeholders and fails with an error naming the template and the variable when a declared variable is missing, a supplied variable is undeclared, the body uses an undeclared placeholder, or a declared variable is never used. Values are inserted verbatim. After substitution it collapses runs of three or more newlines to two and trims. A missing template file is a load-time error naming the file. Export `isRenderedPrompt` for the runtime brand check. Add unit tests for each failure case, the empty-optional-block collapse, package-root resolution when the working directory is a temporary directory, and the missing-file error, using fixture templates under `tests/prompts/fixtures/`.

  ```yaml harness-task
  id: "2.1"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/**", "tests/prompts/**"]
  writes: ["src/prompts/render.ts", "tests/prompts/render.test.ts", "tests/prompts/fixtures/**"]
  requirements: ["prompt-templates: Rendering is strict about variables", "prompt-templates: Templates are found regardless of the working directory"]
  scenarios: ["Missing variable", "Unknown variable", "Undeclared placeholder", "Empty optional block", "Rendering from another repository", "Missing template file"]
  verify: ["bun test tests/prompts/render.test.ts", "bun run typecheck"]
  manual: null
  ```

- [ ] 2.2 Create `src/prompts/questions.ts` exporting `loadQuestions(decisionId, variables)`. It reads `prompts/judgment/<decision-id>.yaml` (parsed with the existing `yaml` dependency, cached, package-root relative) with the shape `decision`, `questions: [{id, type, instructions, criteria?}]`, plus entries of the form `{repeat: <listName>, id: "candidate_{{index}}_x", ...}` that expand once per item of `variables[listName]` with a one-based `{{index}}` and the item's own fields. Other `{{variables}}` in instructions and criteria are substituted from `variables`. The result is passed through the existing `validateQuestions` in `src/judgment/questions.ts` so malformed definitions are programming errors naming the decision. Add tests for expansion of three items, duplicate identifiers, an unknown variable, and a choice without options, using fixture YAML under `tests/prompts/fixtures/`.

  ```yaml harness-task
  id: "2.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/judgment/**", "src/prompts/**", "tests/prompts/**"]
  writes: ["src/prompts/questions.ts", "tests/prompts/questions.test.ts", "tests/prompts/fixtures/**"]
  requirements: ["prompt-templates: Judgment questions load through the existing validation"]
  scenarios: ["Per-item questions expand", "Malformed file is a programming error"]
  verify: ["bun test tests/prompts/questions.test.ts", "bun run typecheck"]
  manual: null
  ```

## 3. Move the agent prompts

- [ ] 3.1 Move every agent prompt identified by the capture script into `prompts/agents/<name>.md` with a variables front matter, and replace each in-code builder with a call to `renderPrompt`. Conditional sections (such as the preflight candidates block and the planning prior-results block) become optional-block variables that the caller sets to an empty string when absent. Change the `prompt` option of the spawn entry point (`runAgent` in `src/agents/spawn.ts`) to require a `RenderedPrompt` and reject anything else at runtime before starting a child process. The goldens from task 1.1 must pass byte for byte. Delete the now-empty in-code prompt builders and any dead helper they used.

  ```yaml harness-task
  id: "3.1"
  dependsOn: ["2.1"]
  role: builder
  reads: ["src/**", "tests/**", "prompts/**"]
  writes: ["prompts/agents/**", "src/change/**", "src/controller/review.ts", "src/review/**", "src/agents/spawn.ts", "tests/prompts/**", "tests/muster/**", "tests/review/**", "tests/commands/**"]
  requirements: ["prompt-templates: Every agent prompt and every judgment question is a template file", "prompt-templates: Agents accept only rendered prompts", "prompt-templates: Moving wording preserves it exactly"]
  scenarios: ["An agent prompt is read from a file", "A raw string is rejected", "Agent prompts match their goldens"]
  verify: ["bun test tests/prompts", "bun test tests/muster", "bun test tests/review", "bun run typecheck"]
  manual: null
  ```

## 4. Move the Jev questions

- [ ] 4.1 For the decisions with a fixed question list (planning complexity, review task focus, task routing, review triage, command classification), create `prompts/judgment/<decision-id>.yaml` with the wording copied exactly from `src/judgment/questions.ts`, and make each decision's `questions` function call `loadQuestions`. Keep the question identifier constants in code. Remove the moved wording from `questions.ts`. The golden fingerprints and the existing judgment tests must pass unchanged.

  ```yaml harness-task
  id: "4.1"
  dependsOn: ["2.2"]
  role: builder
  reads: ["src/judgment/**", "tests/judgment/**", "tests/prompts/**"]
  writes: ["prompts/judgment/**", "src/judgment/questions.ts", "src/judgment/gates.ts", "tests/prompts/**", "tests/judgment/**"]
  requirements: ["prompt-templates: Every agent prompt and every judgment question is a template file", "prompt-templates: Moving wording preserves it exactly"]
  scenarios: ["A decision's questions are read from a file", "Questions match their fingerprints"]
  verify: ["bun test tests/prompts", "bun test tests/judgment", "bun run typecheck"]
  manual: null
  ```

- [ ] 4.2 Do the same for the decisions whose questions depend on their input: planning preflight (per candidate), review extraction (per candidate line), and planning task quality (per task and per requirement), using `repeat` entries. Leave `context.capsule_ranking` and `debugging.thrash` in code and record them in a temporary exclusion list in `tests/prompts/exclusions.ts`, each line naming the change that deletes or replaces them (simplify-03-judgment-core and simplify-06-lean-execution). Add a test that every decision in the catalog either has a YAML file or is in the exclusion list, and that every question identifier a gate reads is present in its file.

  ```yaml harness-task
  id: "4.2"
  dependsOn: ["4.1"]
  role: builder
  reads: ["src/judgment/**", "tests/judgment/**", "tests/prompts/**"]
  writes: ["prompts/judgment/**", "src/judgment/questions.ts", "src/judgment/gates.ts", "tests/prompts/**", "tests/judgment/**"]
  requirements: ["prompt-templates: Every agent prompt and every judgment question is a template file", "prompt-templates: Judgment questions load through the existing validation", "prompt-templates: Moving wording preserves it exactly"]
  scenarios: ["A decision's questions are read from a file", "A doomed decision is excluded by name", "Per-item questions expand", "Gate identifiers exist in the file", "Questions match their fingerprints"]
  verify: ["bun test tests/prompts", "bun test tests/judgment", "bun run typecheck"]
  manual: null
  ```

## 5. Packaging and documentation

- [ ] 5.1 Add `prompts` to the `files` array in `package.json`. Write `prompts/README.md` (one page) documenting the two file kinds, the front-matter variable declaration, the strictness rules, optional blocks, the YAML question format including `repeat`, and how to regenerate goldens with `tests/prompts/capture.ts` when wording changes on purpose. Link it from `AGENTS.md` conventions. Run `bun run docs:check`.

  ```yaml harness-task
  id: "5.1"
  dependsOn: ["3.1", "4.2"]
  role: builder
  reads: ["package.json", "AGENTS.md", "prompts/**", "docs/**"]
  writes: ["package.json", "prompts/README.md", "AGENTS.md"]
  requirements: ["prompt-templates: Templates are found regardless of the working directory"]
  scenarios: ["Rendering from another repository"]
  verify: ["bun run docs:check", "bun run typecheck"]
  manual: null
  ```
