## Why

Planning is the most expensive step of a small change and its output format is the least reliable.

- The synthesis session must return all four artifacts (proposal, design, one or more specs, tasks) as a single JSON object with every artifact's Markdown escaped inside a string. One unescaped quote invalidates the whole response and costs a second full synthesis. The retry message spends tokens telling the model to escape quotes.
- Task metadata (ids, dependencies, scopes, requirement and scenario references, verification commands) is written by the model as YAML inside Markdown inside JSON. Nothing checks it until `/change implement` parses it. A reference to a requirement that does not exist, a verification command the host runner will refuse (`cargo`), or a dependency cycle is discovered after review has approved the plan.
- A preflight agent session runs before planning only to decide whether the request should proceed, and the planning session then reads the same code again.
- Every change, however small, gets an LLM reviewer session that reads artifacts another session just wrote, followed by a Jev task-quality check that only advises.
- `planning.ts` is 810 lines mixing budget parsing, preflight schema and parsing, prompt building, JSON extraction, path guarding, risk resolution, judgment calls and orchestration, and its runtime test is 1,287 lines.

## What Changes

- Introduce a typed plan (summary, why, changes, capabilities, requirements with scenarios, optional design, tasks with metadata) validated by a schema. The planning session returns a plan, or a clarification or already-satisfied disposition, instead of artifact text. The prompt's schema description is generated from the same schema.
- Validate the plan in code before anything is written: task references resolve to plan requirements and scenarios, identifiers are well formed, dependencies are acyclic, and every verification command parses and uses an executable the verification profile allows. Validation errors go back to the session once, as a specific list.
- Render `proposal.md`, `specs/**`, `design.md` and `tasks.md` from the plan with templates. The model never writes artifact paths. Every lane writes all four artifacts.
- Remove the preflight agent session. Disposition is part of the planning session's answer when triage did not decide it.
- Add plan lint, a deterministic set of checks that runs at the start of `/change review` on every lane and blocks with a precise list before any reviewer runs. Lint also checks references against the real spec files and the credential denylist on write scopes.
- Small lane: after lint, one Jev `plan.lint` request (the six task-quality concerns, now gating) decides approval. A clean, confident answer, or an unavailable service, records a lint approval in `review.md` and no reviewer runs. A finding, an uncertain answer or a violated lane limit escalates the change to medium and runs the reviewer.
- Medium and large lanes: unchanged reviewer, now with lint first and `plan.lint` findings as unverified notes, as task quality notes are today.
- Replace `planning.task_quality` with `plan.lint`, asked at review time instead of plan time, removing the record-binding and outcome-reconciliation machinery.
- Split `planning.ts` into a small phase file and a `src/planning/` library.

## Capabilities

### New Capabilities

- `structured-planning`: the typed plan, code-side validation and rendering, disposition inside the planning session, and artifacts written for every lane.
- `plan-lint`: deterministic lint, the Jev semantic check, lint approvals in `review.md`, escalation, and lane limits.

### Modified Capabilities

- `judgment-task-quality`: removed; replaced by the `plan.lint` requirements in `plan-lint`.

## Impact

- **New:** `src/planning/` (plan schema, validation, rendering, session, orchestration, budget), `src/review/plan-lint.ts`, `src/judgment/decisions/plan-lint.ts`, `prompts/agents/planning-plan.md` and revised opinion and debate prompts, `prompts/artifacts/*.md` for rendering, `prompts/judgment/plan.lint.yaml`.
- **Removed:** the preflight prompt and schema, the artifact bundle parser and path guard, `controller/task-quality.ts` binding and reconciliation, the `planning.task_quality` decision, and most of `tests/muster/planning-runtime.test.ts`, replaced by smaller focused tests.
- **Changed:** `src/change/phases/planning.ts` shrinks to a thin phase; `src/change/phases/review.ts` gains the lint path; `review.md` gains a mode; lane policy gains plan review mode, task limit and manual-task permission.
- **Behavior:** malformed task metadata and unresolvable references now fail at propose or refine with a specific message instead of at implement. A small change costs one planning session and no reviewer session in the common case.
- **Persisted records:** `review.md` gains a `mode` field (`reviewer` or `lint`). Existing review files without it are read as `reviewer`.
- **Prerequisite:** simplify-04-triage-lanes, for the lane and its policy table.
