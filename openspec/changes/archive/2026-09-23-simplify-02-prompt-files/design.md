## Context

Agent prompts today: `renderExplorePrompt` (exploration.ts), `preflightPrompt` and `planningPrompt` (planning.ts, the latter with a two-shape body for opinion, debate and synthesis stages), `reviewPrompt` (controller/review.ts), `builderPrompt` (builder.ts) and `renderTaskCodeReviewPrompt` (code-review.ts). They are string arrays joined with newlines, with conditional sections built by `splice` and `filter(Boolean)`.

Jev questions: each decision defines `noul`, `choice` and `score` questions in `src/judgment/questions.ts`. Some are fixed lists (complexity, task focus, routing, review triage, command classification, thrash); some depend on the input (per preflight candidate, per review line, per task, per capsule slice). Question wording changes are keyed into recorded fixtures by a hash of the questions, so wording changes are deliberate events.

The `Decision` type already carries a `version` and `questionsFingerprint` exists. `validateQuestions` rejects malformed definitions.

## Goals / Non-Goals

**Goals:**

- Every prompt an agent sees, and every question Jev sees, is a file that can be read and edited without touching TypeScript.
- Rendering mistakes fail loudly and name the file and the variable.
- The move is provably behavior-neutral.

**Non-Goals:**

- Changing wording. Improving prompts is the job of the changes that own each phase.
- Logic inside templates. There are no loops, conditionals or includes.
- Localizing or configuring prompts per user. System prompts from the model-stack YAML remain configuration, not templates.

## Decisions

### 1. Two file kinds, two directories

Agent prompts are Markdown because they are prose read by a model and reviewed by people: `prompts/agents/<name>.md`. Jev questions are structured (type, instructions, criteria) so they are YAML: `prompts/judgment/<decision-id>.yaml`, with the decision id as the file name (`planning.complexity.yaml`).

Rejected alternative: TypeScript modules exporting template strings. It keeps wording next to logic, which is the problem being solved, and gives no file-level review.

### 2. Template format and strictness

A Markdown template starts with a front-matter block listing its variables:

```
---
variables: [CHANGE_NAME, USER_REQUEST, CANDIDATES_SECTION]
---
Body text with {{CHANGE_NAME}} ...
```

Rendering takes a variables object and fails with an error naming the template and variable when a declared variable is missing, when a supplied variable is not declared, or when the body uses a placeholder that is not declared. A declared variable that the body never uses is also an error, so dead variables cannot linger. Values are inserted verbatim with no escaping, because prompts are not markup.

Optional blocks are variables. The caller passes an empty string when a block is absent, and the renderer collapses runs of three or more newlines to two and trims the result, so an absent block leaves no gap. This reproduces today's `filter(Boolean)` and `splice` behavior without conditionals in templates.

Lists and objects that prompts embed as JSON (for example a task's requirements) are rendered by the caller with `JSON.stringify` and passed as strings, exactly as today.

### 3. Rendered prompts are a distinct type

`renderPrompt` returns a branded `RenderedPrompt`. The spawn entry point's `prompt` option accepts only that type, and checks the brand at runtime as well, so a raw string cannot reach an agent through a cast-free path. This is what makes "every prompt is a file" enforced rather than conventional.

### 4. YAML question files

```
decision: planning.complexity
questions:
  - id: public_contract
    type: noul
    instructions: "Does the request change ..."
  - id: reach
    type: score
    instructions: "How far ..."
    criteria: ["Confined ...", "Affects ..."]
  - repeat: candidates
    id: "candidate_{{index}}_implements"
    type: noul
    instructions: "Does {{reference}} implement ..."
```

`repeat: <name>` expands the entry once per item of the named list, giving `{{index}}` (one-based) and any per-item variable the caller supplies. Non-repeated instructions may also use `{{variables}}` supplied by the caller. Expansion happens in the loader; the result goes through the existing `validateQuestions`, so duplicate ids, empty options and the like are still programming errors that name the decision.

Question identifiers stay as constants in code, because gates read answers by identifier. A test cross-checks that every identifier a gate reads exists in the decision's YAML.

### 5. Proving nothing changed

Before any prompt moves, a test-support script renders every agent prompt from fixed sample inputs and every decision's questions from its representative input, and writes them under `tests/prompts/golden/`. After the move, tests render the same inputs through the new path and compare byte for byte; for questions the comparison is on the canonical JSON that `questionsFingerprint` already hashes. Recorded Jev fixtures also keep matching, which is a second, independent check.

The goldens are permanent. Later changes that edit wording regenerate the affected file in the same diff, which is what makes a wording change visible.

### 6. Location resolution and packaging

The renderer finds `prompts/` relative to the package root, not the working directory, so a Pi session started in another repository (such as minding) still resolves templates. `package.json` `files` gains `prompts`. A missing template is a load-time error naming the file, as the old library did.

## Risks / Trade-offs

- **Whitespace differences in the move** -> The golden comparison is byte-level, so any difference fails a test.
- **Strict unused-variable errors slow prompt edits** -> The error message names the variable, and the rule catches the typo class that empty-string substitution hides.
- **YAML folding alters wording** -> Long instructions use quoted single-line scalars or folded blocks whose result the fingerprint comparison covers.
- **Two file formats to learn** -> `prompts/README.md` documents both in one page.

## Migration Plan

Capture goldens, add the renderer and loader with tests, move agent prompts one file at a time, then move decisions. Each step passes the golden tests. Rollback is a revert; no persisted format depends on where wording lives.
