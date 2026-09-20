## Why

Prompt wording is code. Six agent prompts are template literals inside the phases that use them (exploration, planning preflight, planning stages, planning review, builder, task review), and the wording of every Jev question lives in one 779-line module beside its identifiers and validation. Tuning a prompt means editing TypeScript in a 800-line phase file, a reviewer cannot tell a wording change from a logic change in a diff, and the only protection against a typo in a variable is that the model behaves oddly.

The retired extension had a small prompt library (`{{KEY}}` templates in Markdown files) that showed the right shape but silently replaced a missing variable with an empty string, which hides exactly the mistakes templates should catch. The `/change` pipeline never used it.

The next four changes rewrite planning, review and execution prompts and add Jev decisions. Doing that on inline strings would mean editing the same large files the refactors are trying to shrink. Templates first turns each later prompt change into a small file edit.

## What Changes

- Add a `prompts/agents/` directory of Markdown templates, one per agent prompt, and a `prompts/judgment/` directory of YAML files, one per Jev decision, holding the question wording.
- Add a strict renderer: a template declares its variables, and rendering fails on a missing, unknown or unused variable, naming the template and the variable. Optional blocks are variables that may be empty.
- Add a Jev question loader that reads a decision's YAML, expands per-item questions, and validates the result with the existing question validation.
- Type prompts so an agent can only be started with a rendered prompt, not a raw string.
- Prove the move changes nothing: golden files of every rendered agent prompt and every decision's questions are captured from the current code first, and the new renderers must reproduce them byte for byte.
- Package the `prompts/` directory and document its conventions.

No prompt or question wording changes in this change.

## Capabilities

### New Capabilities

- `prompt-templates`: where agent prompts and Jev questions live, how templates declare and check variables, that agents accept only rendered prompts, and that the move preserves wording.

### Modified Capabilities

None.

## Impact

- **New:** `prompts/agents/*.md`, `prompts/judgment/*.yaml`, `src/prompts/` (renderer and question loader), `tests/prompts/` with golden files.
- **Shrinks:** `src/change/phases/planning.ts`, `exploration.ts`, `task-steps/builder.ts`, `task-steps/review.ts`, `src/controller/review.ts`, `src/review/code-review.ts` lose their inline prompt text; `src/judgment/questions.ts` loses about 600 lines of wording and keeps helpers, identifiers and validation.
- **Package:** `prompts` is added to `package.json` `files`.
- **Behavior:** none. Judgment fixtures recorded against the current questions keep matching because the questions render identically.
- **Prerequisite:** simplify-01-retire-legacy-surface, which deletes the old prompt library and the demo prompts so `prompts/` has one owner.
