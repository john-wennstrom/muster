# Prompts

Every prompt an agent is sent, and every question the judgment service is asked, is a file here. Source code supplies variable values and nothing else. A wording change is a file edit, and the golden files under `tests/prompts/golden/` make it visible in review.

## Agent prompts: `prompts/agents/<name>.md`

Markdown, with a front matter block that declares the variables the body may use:

```
---
variables: [CHANGE_NAME, USER_REQUEST, CANDIDATES_BLOCK]
---
Change: {{CHANGE_NAME}}

User request: {{USER_REQUEST}}

{{CANDIDATES_BLOCK}}
```

Render one with `renderPrompt(name, variables)` from `src/prompts/render.ts`. It returns a `RenderedPrompt`, which is the only kind of prompt `runAgent` accepts; a string built by hand is rejected before a process starts.

Rendering is strict. It fails, naming the template and the variable, when

- a declared variable is not supplied,
- a supplied variable is not declared,
- the body uses a placeholder that is not declared, or
- a declared variable is never used in the body.

Values go in verbatim, with no escaping. A caller that embeds JSON passes `JSON.stringify(...)` as the value.

### Optional blocks

An optional block is a variable the caller sets to an empty string when the block is absent. A placeholder alone on its line vanishes with its line break when its value is empty, and any run of blank lines the template's own text is left with is closed up. A block that has its own heading is its own template (`explore-context.md`), rendered first and passed in as the value. The builder's `PRIOR_FAILURE` block is the other kind: a few lines built by `failureBlock` from the task's latest failure record, and empty on a first attempt, so a first attempt's prompt has no trace of it.

There are no loops, conditionals or includes. Lists are built by the caller and passed as text.

## Artifact templates: `prompts/artifacts/<name>.md`

The proposal, the delta specifications, the design and the task list are rendered from these files by `src/planning/render.ts`, using the same strict renderer, from a validated plan. `proposal.md`, `design.md`, `spec.md` and `tasks.md` are the artifacts; the other files (`requirement.md`, `scenario.md`, `task.md`, and so on) are the blocks the artifacts are built from. A task renders as the checkbox line followed by its `yaml harness-task` block, so the task loader reads it unchanged. `tests/planning/golden/` holds the rendered artifacts of two sample plans; regenerate them with `bun run tests/planning/capture.ts` when a template changes on purpose, and review the diff.

## Judgment questions: `prompts/judgment/<decision-id>.yaml`

One file per decision, named for its id (`change.triage.yaml`):

```yaml
decision: change.triage
questions:
  - id: disposition
    type: choice
    instructions: "What should planning do?"
    criteria:
      "proceed": "The request asks for work the code does not already do."
      "already_satisfied": "The code shown already does what the request asks."
  - repeat: candidates
    questions:
      - id: "candidate_{{index}}_implements"
        type: noul
        instructions: "Does candidate {{index}}, the entry with index {{index}} in the state's candidates list, already implement it?"
```

- `type` is `noul`, `choice` or `score`. A `choice` has a map of options in `criteria`, a `score` has a list, and a `noul` may have `true` and `false` texts. Quote the keys of a `noul` map, because a bare `true` is a boolean in YAML.
- `repeat: <list>` expands its `questions` once per item of the list the caller passes under that name, in item order. `{{index}}` is the one-based position, and every string or number field of the item is available as `{{field}}`. A single question may also carry `repeat`, `id`, `type` and `instructions` directly.
- Other `{{variables}}` come from the variables the caller passes to `loadQuestions(decisionId, variables)`. An unknown variable is an error naming the decision.
- The expanded result goes through `validateQuestions`, so a duplicate id, an empty choice or an empty instruction is a programming error naming the decision.

Question identifiers stay as constants in `src/judgment/questions.ts` because gates read answers by identifier. `tests/prompts/question-files.test.ts` checks that every catalogued decision has a question file and that every identifier a gate reads exists in it. There is no exception list.

## Changing wording on purpose

1. Edit the template or YAML file.
2. Run `bun run tests/prompts/capture.ts`. It rewrites `tests/prompts/golden/` from the sample inputs in `tests/prompts/samples.ts`.
3. Review the golden diff. It is the whole effect of the wording change.
4. Bump the decision's `version` in `src/judgment/gates.ts` when a question changed, so recorded fixtures are not reused for the new wording.

Templates are found relative to the installed package, never the working directory, so a session started in another repository still resolves them. `prompts` is listed in `package.json` `files`.
