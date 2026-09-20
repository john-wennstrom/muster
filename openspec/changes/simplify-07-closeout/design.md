## Context

Changes 01 to 03 and 06 each added an entry to a temporary allowlist for a module or decision that a later change removes. The size limits in the earlier specs ("none larger than about 250 lines") are stated per module and enforced by nothing. The end-to-end lifecycle test drives the whole flow with injected doubles for the agent child, so it can count sessions.

## Goals / Non-Goals

**Goals:**

- The invariants the series establishes are tests, not intentions.
- Documentation cannot silently omit a command or a decision.

**Non-Goals:**

- Lowering test coverage. Splitting test files must keep every test.
- Measuring real token cost. That needs a live run and is the manual acceptance in the README.
- A generic lint framework.

## Decisions

### 1. Budgets are Bun tests

`tests/layering/size-budget.test.ts` counts lines of every `src/**/*.ts` and fails above 500, naming the file. The limit is deliberately looser than the 250-line target in the module specs: the specs describe intent for the modules the series creates, and the budget is a backstop for everything. Test files over 600 lines fail unless their first comment contains a line beginning `size-budget:` with a reason. No allowlist file exists; a justified exception is in the file itself, where a reviewer sees it.

### 2. Session budgets count spawns

The e2e lifecycle test already substitutes the child runner. A counter around that substitute records each agent started with its kind (plan, opinion, debate, builder, reviewer, planning reviewer). The small-lane scenario uses a scripted judgment client answering triage as small, `plan.lint` clean and the focus questions as good, and asserts: plan session 1, builder 1, task reviewer 0 or 1, planning reviewer 0, total at most 3. The medium-lane scenario uses a client that abstains and asserts at most 4: plan, planning reviewer, builder, task reviewer. A third scenario (large) only asserts that opinions and a debate ran.

These numbers are the series' promise. If a later change needs more sessions, the test is edited in that change with a stated reason.

### 3. Documentation currency

`scripts/docs/check.ts` already validates links, fences and command examples. It gains two checks: every decision id in the catalog appears in the first column of `docs/security.md`'s call-site table (this is the "a call site with no row must not ship" rule, previously unenforced), and `docs/command-flow.md` mentions every action in the command table and every catalogued decision id. Both fail with the missing names.

### 4. Documentation refresh is tasks, not prose here

The refreshed diagrams must describe the pipeline as implemented, so they are written after the code lands, from the code, with the same red and green marking as before (LLM sessions and Jev calls) and the lane branches added.

## Risks / Trade-offs

- **A 500-line budget is arbitrary** -> It sits above every module the series leaves (the largest are about 460 lines) and below the sizes that caused the problem (810 and 1,275).
- **Session-budget tests over-fit the stubs** -> They count spawns, not tokens, and say so; the real measurement is the manual acceptance run.
- **Documentation checks add friction to every new decision** -> That is the intent; a decision without an egress row must not ship.

## Migration Plan

Tests first (they fail until the earlier changes are complete, which is why this is last), then splits, then documentation. Rollback is a revert.
