## Context

`runProductionPlanning` runs a preflight agent (or judgment), classifies, optionally runs specialist opinions and a debate for architectural changes, then a synthesis session that must return `{ "artifacts": [{ "path": ..., "content": ... }] }`. `writeArtifacts` parses the bundle, guards paths (`proposal.md`, `design.md`, `tasks.md`, `specs/<capability>/spec.md`), asks Jev for task quality on the task list, and writes files. `controller/planning.ts` retries synthesis once with the rejection reason if `writeArtifacts` throws.

`/change review` runs `reviewChange`: discover and hash artifacts, optionally triage an edit, dispatch a fresh reviewer, write `review.md` with a digest-bound verdict. Task quality notes from plan time reach the reviewer as advice.

The task loader validates tasks against the requirement and scenario references the tasks themselves cite, because the spec files are not read at that point, so a reference that names nothing is accepted. The verification profile allows only `bun`, `node`, `npm`, `npx`, `git` and `openspec`.

## Goals / Non-Goals

**Goals:**

- One planning session per change (plus opinions and a debate on large), returning something code can check completely.
- Every structural mistake is found before review, with a specific message.
- The small lane needs no reviewer session when nothing is wrong.
- All lanes produce the same four OpenSpec artifacts.

**Non-Goals:**

- Removing the reviewer. Medium and large keep it; the small lane can escalate into it.
- Changing what OpenSpec artifacts contain or how they are validated by OpenSpec itself.
- Patch-based refinement. Refine still returns a whole plan from the current artifacts.
- Removing the fusion-driven schema or its instructions.

## Decisions

### 1. The plan is data

```
Plan =
  | { disposition: "plan", summary, why, changes[], capabilities: { new[], modified[] },
      impact[], requirements[], design?, tasks[] }
  | { disposition: "needs_clarification", summary, question, evidence[] }
  | { disposition: "already_satisfied", summary, question?, evidence[] }
```

A requirement is `{ capability, name, kind (ADDED|MODIFIED|REMOVED|RENAMED), text, scenarios: [{ name, when, then }] }`. A task is `{ id, group, description, dependsOn, role, reads, writes, requirements: [{ capability, name }], scenarios[], verify[], manual? }`. Free-text fields are Markdown strings, so prose is not constrained. The schema is a zod definition; the prompt's schema section is generated from it (`z.toJSONSchema`) so the two cannot drift.

### 2. Validation before writing

Beyond the schema: capability names are kebab-case; task ids match `N.M` and are unique; every task requirement reference names a requirement in the plan, and every scenario a task cites exists under a requirement it cites; every scenario belongs to at least one requirement and every requirement has a scenario; the dependency graph compiles as a DAG; every verify command parses under the existing shell-safe parser and its executable is allowed by the verification profile; write scopes are repository-relative. Errors are a list with paths (`tasks[1].verify[0]: executable "cargo" is not allowed by profile verification`). On failure the session gets the list and one more attempt, the same attempt budget as today, but the retry message is specific.

Rejected alternative: keep free-form artifacts and add a linter. The linter would have to parse what code can simply generate.

### 3. Rendering

Templates under `prompts/artifacts/` (`proposal.md`, `design.md`, `spec.md`, `tasks.md`) use the same strict renderer from change 02. Code builds list sections (requirements, scenarios, task blocks) and passes them as variables. Task blocks render as the existing `harness-task` YAML with the checkbox line, so downstream parsing is unchanged. A missing design renders a one-line design stating that no decisions beyond the proposal are needed, so the OpenSpec `design` artifact always exists and every lane writes all four. Files are written by code to fixed paths under the change root; capability names are validated slugs, so the path guard disappears because there is nothing to guard.

### 4. Disposition rides in the plan session

When triage decided `proceed` with confidence, the plan session is told so and returns a plan. Otherwise the session may return a clarification or already-satisfied disposition instead, and the blocked outcome is built exactly as the preflight agent's was. The separate preflight session, its schema, its 6-call bound and its budget line are deleted. Because the plan session has full read tools and reads the code anyway, nothing is lost.

### 5. One prompt for every lane, lane-specific guidance as a variable

`prompts/agents/planning-plan.md` has a `LANE_GUIDANCE` variable. Small: one requirement, one scenario, one task unless two independent files force two; design optional. Medium: as today. Large: after opinions and a debate, whose prompts also move to files and whose output is analysis text as today. The lane's task limit and manual-task permission come from the policy table.

### 6. Plan lint

`src/review/plan-lint.ts` is pure code over the artifacts on disk:

1. Artifacts exist and parse; `openspec validate --strict` passes through the adapter.
2. Tasks load and validate; every reference resolves against the real `specs/**/spec.md` in the change (a check the implement-time loader cannot make).
3. Every scenario is cited by at least one task, and every task cites at least one requirement, one scenario and has at least one verify command.
4. Verify commands parse and their executables are allowed by the verification profile.
5. No write scope matches the credential denylist or `.git`.
6. The dependency graph is acyclic.
7. Lane limits from the policy table: task count and manual tasks. A violation on the small lane is not an error; it escalates.

A lint failure on any lane is a blocked outcome listing every failure, no reviewer, no model cost. It is the same list the propose retry would have produced, so it mostly catches hand edits.

### 7. `plan.lint`: the semantic half

The six task-quality concerns (verification, scope, atomicity, dependencies, size, coverage) become the questions of `plan.lint`, with the wording moved as a file. It is asked once per `/change review`, over the task list and the requirement text, by the same state builder the plan-time decision used (bounded at 40 tasks). Effects: `adds_advice` and `reduces_work`. Findings are fixed templates filled in by code, never model text.

On the small lane the answer gates:

- Clean and confident, or judgment unavailable: lint approval. Unavailability is not evidence of risk, and a user who asked for small should not be forced into a reviewer by an outage; the record says which checks ran.
- Any confident finding, or any uncertain concern: escalate small to medium, run the reviewer with the findings as unverified notes.

On medium and large the findings are notes to the reviewer, as task quality notes are today, and change no verdict. Asking at review time rather than plan time deletes the digest binding that let a later review find plan-time records, and the outcome reconciliation against first-attempt task results. The reconciliation was measurement only, and escalation now provides the calibration signal.

### 8. `review.md` modes

`review.md` gains `mode: reviewer | lint` and, for lint, a `lint` block listing the checks run and the judged answers. A lint approval carries `model: lint`, so no field claims a model read the text. Freshness rule in the snapshot: a lint approval is current only while the lane is small and its digest matches. Escalating to medium therefore makes the change `REVIEW_REQUIRED` again, and the user runs `/change review` again, which now dispatches the reviewer. That keeps commands deliberate: escalation never runs a reviewer on its own.

### 9. Decomposing planning

`src/planning/`: `plan-schema.ts`, `plan-validate.ts`, `render.ts`, `session.ts` (runs a planning agent), `budget.ts` (the token and cost limit parsing), `run.ts` (orchestration). `phases/planning.ts` keeps only the phase entry and outcome mapping. `controller/planning.ts` keeps opinions, debate and synthesis sequencing without the artifact-write callback and its retry, since retry now belongs to validation.

## Risks / Trade-offs

- **A typed plan may constrain what a large change can express** -> Free-text fields carry arbitrary Markdown, and design decisions are a list of titled bodies. If a needed section is missing the schema gains a field; that is a one-file change.
- **The small lane approves without a human-grade reviewer** -> The user decided a code lint is acceptable for small changes. Lint approvals are labelled honestly and escalate on any doubt.
- **The plan session sometimes returns invalid JSON** -> `embeddedJsonObjects` extraction is kept, and the retry lists the exact errors.
- **Rewriting the 1,287-line planning test** -> Replace it with focused tests per new module and one end-to-end test with the agent stubbed; the old file is deleted, not migrated line by line.
- **Cross-checking references against real specs could reject hand-written plans that used to pass implement** -> That is the point: they were accepted only because the check could not run.

## Migration Plan

Build the schema, validator and renderer with tests, then the prompts and the session, then rewire planning and delete the old paths, then add lint, then the review-path changes and snapshot rule, then documentation. Existing changes keep their artifacts and their `review.md`; no artifact is regenerated. Rollback is a revert.
