# Proposal: Jev as Muster's judgment layer

**Status:** proposal / not implemented
**Author:** drafted 2026-09-19
**Subject:** integrating TypeSafe's Jev (`POST /v1/systemone`) into Muster to reduce cost, tokens, and wall-clock time, and to make the harness measurably better at the decisions it already makes.

---

## 1. Thesis

Every judgment Muster makes today is one of two things:

1. **A hard-coded heuristic in TypeScript.** `classifyChange`'s inputs come from regexes over the user's prompt text. `classifyProhibitedCommand` is an allowlist of executables and argv shapes. `assembleTaskCapsule` fills the context budget in array order. These cost nothing and are frequently wrong.
2. **A full frontier-model child process.** `pi --mode json -p` in a fresh session, budgeted at 15k–50k tokens and $0.08–$0.30 per stage, with timeouts of 30 minutes (planning, review) to 8 hours (builder). These are accurate and cost real money and real minutes.

There is nothing in between. Muster has no way to spend a tenth of a cent and 200 milliseconds to answer "is this prompt actually a security-boundary change?" — so it either guesses with a regex or spawns an architect.

Jev fills exactly that gap. It is a *System One* model: it returns typed values and calibrated probability distributions, generates no text, costs **$0.042 per million input tokens** with output free, and answers in **~100 ms**. A fan-out of 25 narrow questions over an 8k-token state costs roughly **$0.0004** — about **0.5% of one Muster preflight**.

The proposal is therefore not "replace agents with Jev." Jev generates nothing and cannot write a proposal, a spec, or a line of code. The proposal is:

> **Use Jev to decide whether to spawn an expensive agent, what to put in its context, and whether its output needs another expensive agent to check it.**

That is where Muster's money is, and it is precisely the class of decision Jev is built for.

---

## 2. What Jev is, in the terms that matter here

Jev evaluates a **state** (a string, JSON object, or array) against a map of typed **questions**, and returns one typed **answer** per question. Three question types:

| Type | Asks | Returns |
| --- | --- | --- |
| `Choice` | Which of these options? | `choice`, `probabilities` over every option, `confidence` |
| `Score` | Which level on this ordered rubric? | `score` (can land between levels), `legend`, `probabilities`, `confidence` |
| `Noul` | Is this true? | `noul`, the probability of yes, 0–1 (no separate `confidence`) |

Properties that drive the design below:

- **Typed by construction.** The answer is always one of the options you supplied. There is no parsing step and no malformed-output failure mode. (This matters more to Muster than it might sound — see §6.8.)
- **Parallel and independent.** Every question in a request is evaluated against the same state, in isolation. Adding questions barely changes latency and costs only the extra question tokens. No context rot between questions.
- **Calibrated.** Probabilities are trained against outcomes rather than optimized for confident-sounding prose. `confidence` collapses the distribution shape into one number you can threshold on.
- **Cheap enough to be speculative.** Ask every question your code *might* need in one call and let code ignore the irrelevant answers.

Operational facts:

| | |
| --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, bearer auth |
| Model | `jev-1.13.0`; aliases `jev-latest`, `jev-preview` |
| Price | $42 / Btok input, **$0.042 / Mtok**; output tokens free |
| Latency | ~100 ms typical |
| Context | 64k tokens per request total; 32k for `state` plus the single longest question |
| Rate limits | 250,000 tokens/sec, 1,200 requests/min (documented as adjusting dynamically) |
| Input | Text only — string, JSON object, or array of text values |
| SDKs | `@typesafe-ai/sdk` (Node 20+), `typesafe-sdk` (Python 3.10+); both retry `429`/`529` with backoff by default |

Measured numbers from TypeSafe's own cookbooks, useful as calibration:

- **Batching:** 13 questions over a 54,000-character document — one call: **$0.000497, 0.27 s**. Thirteen single-question calls: **$0.006090, 2.71 s**. 12.2× cheaper, 10.0× faster, with answers identical to within run-to-run noise.
- **Re-ranking:** scoring 30 BM25 candidates per query with one Jev question each raised top-1 accuracy from 5% → 18% and top-10 from 38% → 62%.
- **Skill selection:** a two-call rank-then-verify pass in front of an agent's 182-skill roster cut wrong-skill loads from 16.8% → 7.3% and spurious loads from 9.8% → 4.0% (oracle floor: 2.5% / 1.2%).

That last one is the closest published analogue to what Muster does when it decides what a builder should see.

---

## 3. Why Muster is an unusually good fit

Muster's design doctrine and Jev's design doctrine are the same doctrine.

From `README.md`:

> A development controller derives the current lifecycle of a change from a validated `ChangeSnapshot` […] rather than from anything a model reports.

From TypeSafe's *How to build with TypeSafe*:

> Keep control flow, deterministic rules, and side effects in code. […] Break broad judgments into narrow, typed questions. […] Use probabilities and confidence to act, ask for review, or escalate.

Muster already believes code owns the workflow and models supply judgment. It already has a `BudgetLedger` that forecasts an activity before running it, a distinction between `optionalActivities` and `protectedActivities`, a complexity router that gates orchestration, and an evidence-first snapshot model. Every one of those is a place where a calibrated, sub-cent judgment is more useful than either a regex or a frontier agent.

The friction points Jev removes are already visible as scar tissue in the codebase:

- `dropEmptyPreflightQuestion` — a zod preprocessor that exists because *"some models include `question` as `""` instead of omitting it."*
- `embeddedJsonObjects` — a hand-rolled brace-matching JSON scanner, because agents wrap their output in prose.
- `MAX_REVIEW_ATTEMPTS = 2` in `planning-reviewer.ts` — a whole second 30-minute high-thinking review run, spent purely to get a parseable object.

None of these failure modes exist against Jev. Typed output is not a prompt instruction it might ignore; it is the shape of the response.

---

## 4. Design invariants

These are non-negotiable and should be encoded as tests, not just prose. They are what keeps this proposal compatible with Muster's security and determinism posture.

**I1 — Jev never holds lifecycle authority.**
`assertLifecycleTransition`, `createChangeSnapshot`, digest computation, git identity, worktree safety, and writer leases stay exactly as they are. Jev answers feed *cost* and *routing* decisions. A Jev answer may never be the reason a change is `VERIFIED`.

**I2 — Jev may narrow permissions, never widen them.**
The existing deny-lists (`classifyProhibitedCommand`, git subcommand allowlist, tool scoping) run first and unchanged. Jev can add a manual checkpoint; it can never remove one. This is what makes prompt-injection through repo content a non-escalation: the worst a poisoned `state` achieves is an extra checkpoint.

**I3 — Every call site degrades to today's behavior.**
No API key, a `429` that survives backoff, a timeout, a network failure, or `MUSTER_JEV=0` must all produce exactly the behavior Muster has now. Jev being down cannot block a `/change`. This is a hard requirement, tested by injecting a failing client at every call site.

**I4 — Low confidence means spend the money.**
The fail-safe direction is always "do the expensive thing Muster does today." Confidence bands are tuned so that uncertainty costs money, not correctness.

**I5 — Pin the model, record the answer.**
Send `jev-1.13.0`, not `jev-latest`. Record the response's `model` field, every question id, and every probability in the run store alongside the decision it drove. Muster's whole value proposition is auditable evidence; an unpinned alias that silently moves would undermine thresholds tuned against it.

**I6 — Jev is opt-in and its egress is documented.**
Jev is a new third-party egress point for repository content. It ships behind `MUSTER_JEV_API_KEY` plus an explicit enable flag, and `docs/security.md` gains a section naming exactly what leaves the machine at each call site. See §10.

---

## 5. The integration layer: `src/judgment/`

One new library, matching the existing module conventions (frozen returns, `HarnessError` codes, zod validation, injected dependencies so unit tests stay hermetic). It is a library like `src/controller/*` — phases and controllers call it; it calls nothing back.

```
src/judgment/
  client.ts       # JevClient wrapper: pinned model, timeout, retry, abort signal
  ask.ts          # askJev(): the single entry point, with fallback contract
  questions.ts    # the catalog — every question Muster asks, in one reviewable place
  gates.ts        # confidence bands and thresholds, per decision, in one place
  usage.ts        # UsageRecord emission so Jev spend lands in the BudgetLedger
  record.ts       # record/replay fixtures for tests
```

### 5.1 The fallback contract

Every call site gets an answer or the fallback — never an exception, never a hang.

```ts
export interface JudgmentRequest<Q extends Questions> {
  /** Names the decision, for telemetry, fixtures, and the audit record. */
  decision: string;
  runId: string;
  phase: UsagePhase;
  role: UsageRole;
  taskId?: string;
  state: JsonValue;
  questions: Q;
  signal?: AbortSignal;
}

export type JudgmentResult<Q extends Questions> =
  | { available: true; answers: ResultFor<Q>; model: string; usage: UsageRecord }
  /** Disabled, unconfigured, rate-limited, timed out, or failed. Caller does what it does today. */
  | { available: false; reason: JudgmentUnavailableReason };
```

`askJev` never throws for an operational failure. It throws only for a programming error — a malformed question catalog entry — which is a `HarnessError("JUDGMENT_QUESTION_INVALID", …)` caught at build time by the catalog's own tests.

Call sites read like this, and the shape makes I3 and I4 structurally hard to violate:

```ts
const judgment = await askJev({ decision: "planning.complexity", /* … */ });
if (!judgment.available) return todaysRegexHeuristic(prompt);       // I3
const { public_contract, data_migration, security_boundary } = judgment.answers;
```

### 5.2 Budget and telemetry integration

Jev spend must be visible in the same ledger as everything else, or the cost story is unverifiable.

- Add `"judgment"` to `UsageRole` in `src/telemetry/usage.ts`. The `phase` stays whatever phase the caller is in, so Jev spend rolls up under `planning` / `implementation` / `validation` naturally.
- Add `"judgment"` to `BudgetActivity` in `src/telemetry/budget.ts`, in the **optional** set. A budget-exhausted Jev call is a `skipped_optional` decision, which falls back to today's behavior — which is exactly I3.
- Record `inputTokens` from the response `usage` block and compute `costUsd` from the pinned per-Mtok rate. Output tokens are free and should be recorded as `0`, not omitted.

The pleasing consequence: `BudgetLedger.forecast` already returns `estimatedSaving` for skipped optional activities. Jev's *own* saving — the expensive activity it prevented — can be recorded through the same field, so `bun run` telemetry reports show what the judgment layer bought.

### 5.3 Question catalog

Every question Muster asks lives in `questions.ts`, not inline at the call site. Reasons, in order of importance:

1. Question wording is the tuning surface. Jev is documented as **literal** — it answers the question you wrote, not the one you meant. Wording changes need review like a prompt change, and diffs need to be readable.
2. Thresholds are tuned per question and must be versioned next to it.
3. The catalog is what you replay in tests (§9) and what you point at a labelled corpus when calibrating.

---

## 6. The integrations

Ordered by expected return. Each gives today's behavior, the proposed questions, the code-side gate, and an honest note on risk.

### Tier 1 — highest leverage

---

#### 6.1 Complexity classification — replace four regexes

**File:** `src/change/phases/planning.ts` (the `classifyChange` call site), `src/controller/complexity-router.ts`

**Today.** The four risk booleans that drive orchestration are regexes over the user's free-text prompt:

```ts
hasPublicContractChange: /\b(?:public contract|api|schema|protocol)\b/i.test(effectivePrompt),
hasDataMigration:        /\bmigrat(?:e|ion)\b/i.test(effectivePrompt),
hasSecurityBoundaryChange: /\b(?:security|permission|auth)\b/i.test(effectivePrompt),
hasDesignAmbiguity:      options.phase === "refine" && /\b(?:ambiguous|trade-?off|uncertain)\b/i.test(effectivePrompt),
```

These are wrong in both directions, and both directions cost money:

- *"Don't migrate the data, just add a column"* matches `migrat(e|ion)` → `high` severity → `architectural` → `specialist_opinion` (20k / $0.12) **and** `debate` (25k / $0.15) **and** the configured architect thinking level. ~$0.27 and two extra agent round trips, spent on a false positive.
- *"Change the wire format between the broker and the child"* matches nothing → `direct` → `thinkingForPlanning` drops to `"low"`, optional orchestration is skipped entirely. The change gets planned badly, fails review, and the whole planning phase re-runs.

**Proposal.** Keep `classifyChange` and its severity ladder byte-for-byte. Replace only the four boolean *inputs* with four Nouls, over a state that includes the preflight evidence — which is already computed by the time `classifyChange` is called.

```ts
state = {
  request: effectivePrompt,
  phase: options.phase,
  evidence: preflight.evidence,        // [{ path, reason }], already available
  affected_paths: affectedFiles,
}
questions = {
  public_contract:   noul({ question: "Does the request change a contract that code outside this repository depends on?",
                            focus: "An externally observable API, wire format, schema, CLI surface, or protocol — not an internal function signature." }),
  data_migration:    noul({ question: "Does the request require migrating, backfilling, or reshaping data that already exists?",
                            focus: "Require it — a request that explicitly avoids a migration is a no." }),
  security_boundary: noul({ question: "Does the request change what an actor is permitted to do, or what is trusted?",
                            focus: "Authorization, authentication, tool scoping, command brokering, or secret handling." }),
  design_ambiguity:  noul({ question: "Does the request leave a material design decision unresolved?",
                            focus: "Unresolved in the request itself, such that a reasonable implementer could pick two incompatible designs." }),
  // speculative — free, and used by §6.2 and §6.12
  mostly_mechanical: noul({ question: "Could this change be carried out by following a stated pattern without design judgment?" }),
  blast_radius:      score({ question: "How far does this change reach?",
                             criteria: ["One function or file", "One capability", "Several capabilities", "Cross-cutting, or changes a shared invariant"] }),
}
```

**Gate.** `noul > 0.7` → true; `noul < 0.3` → false; **in between → fall back to today's regex for that one boolean.** This is I4 applied per-signal, and it means the ambiguous middle costs exactly what it costs now.

Note the wording carries the fix for a known Jev failure mode: negation and scoping are read literally, so `"Require it — a request that explicitly avoids a migration is a no"` belongs in the question, not in a comment.

**Cost.** Six questions over a ~1k-token state: **~$0.00005**. Against a $0.27 mis-escalation.

**Risk.** Low. Bounded by the existing severity ladder, and the override path (`ComplexityOverride`, user or controller, with a mandatory auditable reason) is untouched.

---

#### 6.2 Planning preflight — keep the retrieval, move the judgment

**File:** `src/change/phases/planning.ts`

**Today.** `runProductionPlanning` spawns a full architect child in brokered mode, capped at `PREFLIGHT_MAX_TOOL_CALLS = 6` read/search calls, budgeted at **15,000 tokens / $0.08**, with a 30-minute timeout. It must return exactly one JSON object with a `disposition` of `proceed` / `needs_clarification` / `already_satisfied`. Getting that object back reliably required `dropEmptyPreflightQuestion` and `embeddedJsonObjects`.

**Proposal.** Split it the way the jaggedness guidance says to split things: *retrieval is code, judgment is the model*.

1. **Code retrieves.** Extract identifiers and paths from the request, ripgrep the repo, take the top N files with a few hundred bytes of surrounding context each. This is free and deterministic, and it is exactly the work the 6 tool calls were doing.
2. **One Jev call judges.** State is `{ request, candidates: [{ path, excerpt }] }`. Speculative fan-out:

```ts
questions = {
  disposition: choice({ question: "What should happen with this request against the checked-out repository?" }, {
    proceed:            "The requested behavior is absent or incomplete, and the request is specific enough to plan.",
    already_satisfied:  "The checked-out code already implements the requested behavior.",
    needs_clarification:"The request is too ambiguous to produce a bounded plan.",
  }),
  // one per candidate, built in a loop — this is how you count with Jev
  ...Object.fromEntries(candidates.map((c, i) => [`implements_${i}`,
    noul({ question: `Does \`candidates[${i}].excerpt\` already implement the behavior in \`request\`?`,
           focus: "Implement it, not merely mention or touch the same area." })])),
  ...Object.fromEntries(candidates.map((c, i) => [`relevant_${i}`,
    noul({ instructions: `Would \`candidates[${i}].path\` need to change to satisfy \`request\`?` })])),
  ambiguity: score({ question: "How much is left unspecified?",
                     criteria: ["Fully specified", "One reasonable reading", "Two plausible readings with different work", "Cannot be planned without asking"] }),
}
```

3. **Code composes.** The evidence array that `classifyChange` and the artifact bundle consume is built from the `relevant_*` Nouls above threshold, ranked by probability — no model needs to *write* the evidence list, because code already knows the paths.

**Gate.** `disposition.confidence ≥ 0.80` → act on it directly, skipping the architect child entirely. Below that → run today's preflight child, now with the Jev candidates pre-loaded into its prompt so its 6 tool calls are better spent.

**Cost.** ~$0.0004 replacing a $0.08 budget line — and when it returns a confident `already_satisfied` or `needs_clarification`, it also prevents the entire downstream chain (synthesis $0.30, plus optional stages). The decision to spend $0.65 costs four hundredths of a cent to make.

**Bonus.** On the high-confidence path, `parsePreflight`, `dropEmptyPreflightQuestion`, and `embeddedJsonObjects` stop being on the hot path. They stay for the fallback, but they stop being the thing that breaks at 2am.

**Risk.** Medium, and worth naming: Jev is documented as weak at *indirection*, and "does this code already do X" is a genuine hop. Mitigations are (a) give it excerpts rather than the whole repo — the jaggedness page is explicit that accuracy falls as irrelevant state grows; (b) ask per-candidate rather than globally; (c) the 0.80 confidence floor; (d) `already_satisfied` returns a *blocked* outcome with a question, which is a cheap, reversible, user-visible failure.

---

#### 6.3 Context capsule packing — rank slices instead of taking them in order

**File:** `src/context/assembler.ts`, `src/context/escalation.ts`

**Today.** `assembleTaskCapsule` walks `slices.filter(priority === "relevant")` **in array order**, adding each slice that still fits and skipping ones that don't. Whoever constructed the array decided the priority. There is no relevance judgment anywhere in the pipeline. Everything that doesn't fit is demoted to `available`, reachable only through `escalateContext` — whose `authorize` callback is supplied by the caller and has no notion of relevance either.

This is the highest-stakes packing decision in the harness. Its output is the context of a builder with an **8-hour** timeout.

**Proposal.** This is the re-ranking cookbook, applied to context slices. One Jev call, one Score per slice:

```ts
state = {
  task: { id, definition, requirements, scenarios, decisions, read_scopes, write_scopes, acceptance },
  slices: slices.map(s => ({ id: s.id, excerpt: head(s.content, 600) })),
}
questions = Object.fromEntries(slices.map((s, i) => [`need_${i}`, score({
  instructions: { question: `How necessary is \`slices[${i}]\` for completing \`task\`?`,
                  focus: "Necessary to do the work, not merely topically related." },
  criteria: [
    "Unrelated to the task.",
    "Background; the task can be completed without it.",
    "Useful; would likely be consulted while doing the work.",
    "Required; the task cannot be completed correctly without it.",
  ],
})]));
```

**Gate.** Fill the budget greedily by `score × confidence` instead of array order. A slice scoring "Required" with high confidence that *doesn't fit* is a signal worth surfacing — it likely means the task is too big, which §6.9 catches at plan time. Everything below threshold goes to `available`, and `escalateContext`'s `authorize` gets a principled default: authorize an escalation when the slice's stored score clears a lower bar.

**Cost.** 30 slices with 600-byte excerpts ≈ 8k tokens ≈ **$0.0003**, ~300 ms. Against a builder session.

**Why this is the big one.** The published re-ranking numbers on this exact shape of problem are top-1 5% → 18%, top-10 38% → 62%. The savings aren't in the packing call; they're in the builder runs that don't go down the wrong path, the context escalations that don't happen mid-run, and the repair cycles that don't get triggered. Those are the most expensive events in Muster.

**Risk.** Low, and self-limiting: the capsule's required content and its token budget are unchanged, so the worst case is a differently-ordered set of optional slices.

---

#### 6.4 Planning-review triage — stop re-reviewing typo fixes

**File:** `src/controller/review.ts`, `src/review/artifact-digest.ts`

**Today.** `hashReviewedArtifacts` hashes `proposal.md`, `design.md`, `tasks.md`, and every delta spec. **Any byte change** invalidates the digest, reopens `REVIEW_REQUIRED`, and requires a fresh planning review: a `thinking: "high"`, read-only, full-repo pass with a 30-minute timeout, plus the reviewer-selection and tool-audit machinery around it.

Fixing a typo in `proposal.md` costs a full planning review. During iterative refinement — which is the normal path — this is the single most repeated large expense in the harness.

**Proposal.** On a digest change, before dispatching the reviewer, ask whether the change is *material*:

```ts
state = { previous: previousArtifactText, current: currentArtifactText, unified_diff: diff }
questions = {
  materiality: score({
    instructions: { question: "How much does the change from `previous` to `current` alter what is being proposed?",
                    focus: "Judge the substance, not the size of the diff." },
    criteria: [
      "Formatting, spelling, or wording only; no change in meaning.",
      "Clarifies existing meaning; adds no new obligation and removes none.",
      "Changes, adds, or removes a requirement, scenario, or acceptance criterion.",
      "Changes the scope, the architecture, or a design decision.",
    ]}),
  changes_requirements: noul({ instructions: "Does `current` add, remove, or alter any requirement relative to `previous`?" }),
  changes_scenarios:    noul({ instructions: "Does `current` add, remove, or alter any WHEN/THEN scenario relative to `previous`?" }),
  changes_tasks:        noul({ instructions: "Does `current` add, remove, or reorder any task, dependency, or verification command?" }),
  changes_scopes:       noul({ instructions: "Does `current` alter any declared read or write scope?" }),
  contradicts_approval: noul({ instructions: "Does `current` contradict anything the previous approved review relied on?" }),
}
```

**Gate.** Carry the previous `APPROVE` forward **only** when *all* of: `materiality.score < 1.5`, `materiality.confidence ≥ 0.85`, and every Noul `< 0.25`. Anything else → full review. Record the Jev answers, the previous digest, and the new digest in `review.md` so the audit trail shows exactly why the review was carried forward and on what evidence.

**Cost.** ~$0.0002 against a 30-minute high-thinking review run.

**Risk. Highest in this document, and it should ship guarded accordingly.** This is the one integration that lets a model's answer affect whether a *correctness gate* runs. Therefore:

- **Default off.** `MUSTER_JEV_REVIEW_TRIAGE=1` to enable, documented as a cost/rigor tradeoff.
- Never carries forward a `REVISE`. Only an `APPROVE`, and only forward.
- Never carries forward across more than N consecutive triaged edits (suggest N=3) — accumulated "immaterial" edits are materially different from one.
- Never applies to `specs/**` deltas at all in the first version. Requirements and scenarios are the thing the review exists to protect; start with `proposal.md` and `design.md` prose only.

This is still worth doing. It is just the one that needs a flag, a cap, and a scoped blast radius.

---

#### 6.5 Task code review — focus the reviewer, then (optionally) skip it

**File:** `src/change/phases/task-steps/review.ts`, `src/review/code-review.ts`

**Today.** Every task in the DAG gets a full reviewer child in a fresh session. `renderTaskCodeReviewPrompt` already assembles exactly the right state: task contract, diff digest and summary, test evidence, authorized scopes and violations, TDD evidence. It hands all of it to a frontier model and asks for findings across five areas (`contract`, `diff`, `tests`, `scopes`, `tdd`).

**Proposal, part A (recommended, always on).** Run a Jev fan-out over that same already-assembled state and pass the result to the reviewer as a *focus list*, not as a verdict:

```ts
questions = {
  diff_within_scopes:   noul({ instructions: "Does every file in `diff.summary` fall inside `scopes.writes`?" }),
  diff_matches_contract:noul({ instructions: "Does `diff.summary` implement what `contract.definition` describes?" }),
  tests_cover_scenarios:noul({ instructions: "Does `tests` exercise every scenario in `contract.scenarios`?" }),
  red_green_consistent: noul({ instructions: "Is `tdd_evidence` internally consistent — a failing red stage, then a passing green stage on the same check?" }),
  introduces_stub:      noul({ instructions: "Does `diff.summary` add a TODO, a stub, a hard-coded value, or a silently swallowed error?" }),
  touches_security:     noul({ instructions: "Does `diff.summary` change authorization, command brokering, tool scoping, or secret handling?" }),
  risk: score({ instructions: "How much could this diff break that is not covered by `tests`?",
                criteria: ["Nothing outside the diff", "Callers within the same capability", "Other capabilities", "A shared invariant or security boundary"] }),
}
```

Then, following the skill-suggestion pattern — one extra line, the agent keeps its own judgement:

```
<review_focus>
Attention on: scope violations, test coverage of scenario 2. Ignore this if the diff does not support it.
</review_focus>
```

This is a strict improvement with no gate: the reviewer still returns the verdict, still gets audited for tool use, still produces the `TaskCodeReview`. It just arrives pointed at something. Expect shorter reviewer runs and a better hit rate.

**Proposal, part B (opt-in, `MUSTER_JEV_TASK_REVIEW_SKIP=1`).** Skip the reviewer child entirely when *all* of: not behavior-changing, `risk.score < 1.0` with `confidence ≥ 0.85`, every positive Noul `> 0.85`, every negative Noul `< 0.15`, no recorded scope violations, and the diff is under a configured size. Synthesize an `APPROVE` `TaskCodeReview` whose `findings: []` and whose record names Jev as the reviewer, so `taskReviewApproved` remains evidence-backed and attributable.

**Cost.** ~$0.0003 per task, against one reviewer child per task. On a 12-task DAG this is the difference between 12 reviewer sessions and (say) 7.

**Risk.** Part A: none — it adds a hint and changes no gate. Part B: real, hence the flag and the conjunction of six conditions. Note that `evaluateTaskOutcome` still requires `taskReviewApproved`, `verificationPassed`, `implementationPersisted`, `evidencePersisted`, and a passing TDD policy — Jev would satisfy one of five conditions, not bypass the pipeline.

---

### Tier 2 — reliability that converts directly into cost

---

#### 6.6 Repair-loop thrash detection

**File:** `src/policies/debugging.ts`, `src/execution/task-runner.ts`

**Today.** `DebuggingState` **counts** failures. At `threshold`, `mode` flips from `ordinary_repair` to `systematic_debugging`. The count is the only signal: three attempts that each make real progress and three attempts that re-run the same broken fix are indistinguishable.

Each attempt is a builder session with an 8-hour ceiling. Counting is a very expensive way to notice you're stuck.

**Proposal.** After each recorded failure, one Jev call over the failure history:

```ts
state = { previous: failures.at(-2), current: failures.at(-1), fix_attempted, task_definition }
questions = {
  same_root_cause: noul({ instructions: "Do `previous.evidence` and `current.evidence` indicate the same underlying cause?" }),
  error_changed:   noul({ instructions: "Is the failure in `current` different from the failure in `previous`?" }),
  progress_made:   noul({ instructions: "Did `fix_attempted` move the task closer to passing, even though it still fails?" }),
  cause_located:   noul({ instructions: "Does `current.evidence` identify where the defect is?" }),
  misdiagnosis: score({ instructions: "How well does `fix_attempted` match what `current.evidence` shows?",
                        criteria: ["Addresses the evidence directly", "Plausible but unconfirmed", "Addresses a different symptom", "Unrelated to the evidence"] }),
  needs_human: noul({ instructions: "Does resolving this require a decision, a credential, or access that an automated agent cannot obtain?" }),
}
```

**Gate.** Two consecutive rounds of `same_root_cause > 0.8` **and** `progress_made < 0.3` → flip to `systematic_debugging` immediately, regardless of `threshold`. `needs_human > 0.8` → raise an `AWAITING_USER` checkpoint rather than burning further attempts. Never *raise* the threshold — Jev may only cut a loop short, never extend one (I2, generalized).

**Cost.** ~$0.0001 per failure against a builder attempt.

**Risk.** Low. Early escalation produces a visible, resumable checkpoint; the failure mode is "escalated one attempt sooner than necessary."

---

#### 6.7 Manual-checkpoint classification — widen the net without weakening the deny-list

**File:** `src/tools/host-runner.ts` (`classifyProhibitedCommand`), `src/controller/manual-checkpoint.ts`

**Today.** A fixed pattern list: `sudo`/`doas`/`runas`; `npm|bun|docker login`; `gh auth`; `git push --force`/`-f`; `git reset --hard`; `git clean -f*`; `git branch -d`; `git worktree remove`; `npm|bun publish`. Everything else falls through to the git-subcommand allowlist and the command profile.

Things it does not catch: `git push --force-with-lease`, `gh release create`, `gh pr merge`, `terraform apply`, `kubectl delete`, `aws s3 rm`, `curl -X POST` to a webhook, `docker push`, `rm -rf`, and anything wrapped in an `npm run` script.

**Proposal.** Keep the regex as an unchanged **fast deny**. For commands it *allows*, add a Jev classification:

```ts
state = { executable, args, cwd_relative, profile }
questions = {
  category: choice({ question: "What kind of manual approval, if any, does this command require?" }, {
    none:                "Reads state or runs a local build/test. Fully reversible, no external effect.",
    authentication:      "Obtains, stores, or refreshes a credential.",
    elevated_permission: "Runs with privileges beyond the current user.",
    destructive:         "Deletes, overwrites, or force-rewrites data or history that is not trivially recoverable.",
    external_side_effect:"Has an effect outside this machine — publishes, deploys, posts, or mutates a remote.",
  }),
  irreversible:        noul({ instructions: "Would the effect of this command be hard to undo from this machine?" }),
  mutates_remote:      noul({ instructions: "Does this command write to something outside the local filesystem?" }),
  touches_credentials: noul({ instructions: "Does this command read, write, or transmit a credential?" }),
}
```

**Gate.** Risk-scaled, straight from the confidence-routing pattern:
`category !== "none"` with `confidence ≥ 0.6` → checkpoint. `category !== "none"` with confidence *below* 0.6 → **also** checkpoint (an uncertain classifier on a destructive-operation question is itself a reason to ask a human). `category === "none"` with `confidence ≥ 0.7` → proceed. `category === "none"` below that → proceed, matching today, and log it for threshold calibration.

**Cost.** ~$0.00002 per brokered command.

**Risk.** By construction this can only *add* checkpoints (I2). The adversarial-content caveat applies — Jev does not treat `state` as hostile — but the command itself *is* the state, the deny-list runs first, and a poisoned answer's worst case is a spurious checkpoint. The real cost is annoyance, so start conservative and calibrate against the audit log.

**Note.** This is the one place where the cost argument is secondary. It's a safety improvement that happens to be nearly free.

---

#### 6.8 Eliminate the reviewer JSON-retry run

**File:** `src/review/planning-reviewer.ts`

**Today.**

```ts
const MAX_REVIEW_ATTEMPTS = 2;
```

When a reviewer burns its turn on reasoning and never emits the object, or wraps it in a fence, Muster re-runs the **entire** review — `thinking: "high"`, 30-minute timeout, full repo — to obtain a parseable object it has, in many cases, already been told the contents of in prose.

This is the single most expensive retry in the codebase, and it is spent on formatting.

**Proposal.** On a parse failure, do not re-run the reviewer. Instead:

1. **Code extracts candidates.** Split the reviewer's prose into bullet lines and headed sections with a parser. This is the pre-parsed-value-extraction pattern: code finds the candidate spans, the model picks and classifies.
2. **Jev classifies.**

```ts
state = { reviewer_output: run.text, candidate_lines: lines }
questions = {
  verdict: choice({ question: "What verdict does `reviewer_output` reach?" }, {
    APPROVE: "It raises no blocking problem with the plan.",
    REVISE:  "It raises at least one problem that must be fixed before implementation.",
    UNCLEAR: "It does not reach a verdict.",
  }),
  ...Object.fromEntries(lines.map((l, i) => [`line_${i}`, choice({
    instructions: `How does \`candidate_lines[${i}]\` function in \`reviewer_output\`?` }, {
    critical:       "A defect that blocks the plan.",
    required:       "A change that must be made before implementation.",
    recommendation: "An optional improvement.",
    not_a_finding:  "Narration, restatement, or preamble.",
  })])),
}
```

3. **Code assembles** the `PlanningReviewSubmission` from the classified lines, requiring the verdict/findings consistency the schema already enforces (`REVISE` iff `criticalFindings` or `requiredChanges` is non-empty).

**Gate.** `verdict.confidence ≥ 0.8` and `verdict !== "UNCLEAR"` → assemble and continue. Otherwise → today's retry. Mark the review record as `extracted: true` so the provenance is explicit.

**Cost.** ~$0.0003 against a full 30-minute high-thinking review run.

**Risk.** Low, with one honest limit: **Jev generates nothing.** If the reviewer produced no finding text at all — pure reasoning, no conclusions — there is nothing to classify and the retry still happens. This removes the common case (prose-wrapped findings), not every case.

---

#### 6.9 Task-quality gate at plan time

**File:** `src/change/phases/planning.ts` (after synthesis, before `writeArtifacts`), `src/execution/task-parser.ts`

**Today.** `tasks.md` is validated *structurally*: every checkbox needs an adjacent ` ```yaml harness-task ` block or parsing throws `TASK_DOCUMENT_INVALID`. Semantic quality is not checked anywhere. A task whose `verify` command doesn't actually verify its scenarios, or whose declared write scopes don't cover the files it will need, is structurally valid and fails **hours later, inside a builder** — then costs a repair cycle, possibly a `design_conflict`, possibly a re-plan.

**Proposal.** After synthesis returns the artifact bundle and before it is written, one Jev call over all tasks at once:

```ts
state = { change_summary, requirements, scenarios, tasks: parsedTasks }
questions = {
  ...tasks.flatMap((t, i) => [
    [`verify_covers_${i}`, noul({ instructions: `Would \`tasks[${i}].verify\` actually fail if \`tasks[${i}]\` were implemented incorrectly?` })],
    [`scopes_cover_${i}`,  noul({ instructions: `Do \`tasks[${i}].write_scopes\` cover every file that \`tasks[${i}].description\` would require changing?` })],
    [`atomic_${i}`,        noul({ instructions: `Does \`tasks[${i}]\` describe one coherent unit of work?`,
                                  focus: "A task that would naturally be done as two separate commits is a no." })],
    [`deps_complete_${i}`, noul({ instructions: `Does \`tasks[${i}]\` depend on work not listed in its declared dependencies?` })],
    [`size_${i}`, score({ instructions: `How large is \`tasks[${i}]\`?`,
                          criteria: ["A single edit", "One file", "Several files in one capability", "Too large to verify as one unit"] })],
  ]),
  coverage: noul({ instructions: "Taken together, do `tasks` cover every requirement in `requirements`?" }),
}
```

**Gate.** Findings below threshold become `requiredChanges` fed straight into the planning review artifact — so the human-visible path is unchanged and the reviewer arrives already knowing where to look. Do **not** silently rewrite `tasks.md`; Jev can't write, and synthesizing a fix is a synthesis job.

**Cost.** 12 tasks × 5 questions = 60 questions, one call, ~$0.0005 — comfortably inside the 64k budget. Against a builder run plus a repair cycle plus possibly a re-plan.

**Risk.** Low. It produces findings, not edits. The worst case is a spurious required change, which the reviewer and the user both see.

---

### Tier 3 — cheap wins and a bigger bet

---

#### 6.10 Fill the `UNEXPECTED_ERROR` bucket

**File:** `src/change/failure-classification.ts`

`failureClassifications` is total over `HarnessErrorCode` and deliberately so — it is a lovely piece of design and should not be touched. But `UNEXPECTED_ERROR` is the reserved bucket for anything undeclared, and it carries `{ blocker: null }`: no blocker kind, no guidance, no next action.

**Proposal.** *Only* when `failureCodeOf` returns `UNEXPECTED_ERROR`, ask Jev to place it:

```ts
questions = {
  blocker: choice({ question: "What kind of blocker does this failure represent?" }, {
    missing_artifact: "…", stale_digest: "…", model_unavailable: "…", pending_checkpoint: "…",
    invalid_change: "…", lifecycle: "…", external_capability: "…", invalid_evidence: "…",
    internal_fault: "Nothing the user can satisfy; a defect in the harness itself.",
  }),
  user_actionable: noul({ instructions: "Is there something the user can do to resolve this?" }),
}
```

A declared code's classification is never consulted or overridden — this fills a hole, it does not open one. `confidence < 0.7` → `{ blocker: null }`, exactly as today.

**Cost:** ~$0.00002, on a path that only runs when something already went wrong.

---

#### 6.11 `/change status` that answers the question you actually have

**File:** `src/change/phases/status.ts`

`/change status` is pure computation over the snapshot, which is right. Add one speculative fan-out over the already-computed snapshot for the things a human actually wants to know: is this change stalled, which of the pending checkpoints should be done first (a `Choice` over the real checkpoint ids), is the blocking reason something the user can act on, is the failing branch independent of the rest of the DAG.

One call, ~$0.0001, no state change, no lifecycle authority (I1). It makes the surface people look at most often materially more useful for essentially nothing.

---

#### 6.12 Route mechanical tasks to cheaper models

**File:** `src/agents/model-router.ts`, `src/change/models.ts`

**Today.** `routeModel` filters by role, availability, context, tool support, and cost ceiling, then sorts by `estimatedInputCostPerMillion`. The *task* has no say — a one-line config change and a cross-capability refactor route identically.

**Proposal.** The intent-routing pattern: a cheap classifier in front of expensive handlers. Score each task on `needs_deep_reasoning`, `needs_large_context`, `mostly_mechanical`, `novel_design` (the `mostly_mechanical` Noul from §6.1 is already free in the planning call). Feed the result into `ModelRouteRequest` as a preference so mechanical tasks land on a cheaper builder slot.

**Gate, and it matters:** never downgrade when `security_boundary`, `public_contract`, or `blast_radius ≥ 2` is true; never downgrade below the declared role fallback; never downgrade on a task that has already failed once. `confidence < 0.8` → today's routing.

**Cost.** Free (rides along in the planning call). Potential savings are the largest of anything here on a multi-task DAG, because most tasks in most changes are mechanical — and also the highest quality risk, which is why it is last and most heavily gated.

---

## 7. Cost model

### 7.1 What Muster spends now

From `DEFAULT_BUDGET_ESTIMATES` in `src/change/phases/planning.ts`:

| Stage | Tokens | Cost |
| --- | ---: | ---: |
| `preflight` | 15,000 | $0.08 |
| `specialist_opinion` (architectural only, ≥1×) | 20,000 | $0.12 |
| `debate` (architectural only) | 25,000 | $0.15 |
| `synthesis` | 50,000 | $0.30 |
| **Architectural `/change propose`** | **110,000** | **$0.65** |
| **Direct `/change propose`** | **65,000** | **$0.38** |

Not budget-estimated, and mostly larger: planning review (30-min ceiling, `thinking: "high"`, full repo), per-task builder (8-hour ceiling), per-task code review, final verification, and every repair cycle — each of which re-pays some of the above.

> **Drift worth fixing while you're in here:** `README.md` documents a *"100,000-token / $0.50 phase forecast limit"*, but `planning.ts` has `DEFAULT_PLANNING_MAX_TOKENS = 1_000_000` and `DEFAULT_PLANNING_MAX_COST_USD = 1.5`. One of the two is wrong. Unrelated to Jev, but it is the number a reader will use to sanity-check everything above.

### 7.2 What Jev costs

At **$0.042 / Mtok**, output free:

| Call | State | Questions | Tokens | Cost | Latency |
| --- | --- | ---: | ---: | ---: | ---: |
| Complexity (§6.1) | prompt + evidence | 6 | ~1,200 | $0.00005 | ~150 ms |
| Preflight (§6.2) | request + 10 excerpts | ~25 | ~10,000 | $0.00042 | ~250 ms |
| Capsule packing (§6.3) | contract + 30 excerpts | 30 | ~8,000 | $0.00034 | ~300 ms |
| Review triage (§6.4) | two artifacts + diff | 6 | ~6,000 | $0.00025 | ~250 ms |
| Task review (§6.5) | contract + diff + tests | 7 | ~7,000 | $0.00029 | ~250 ms |
| Task quality (§6.9) | 12 tasks | 61 | ~12,000 | $0.00050 | ~350 ms |

**A full `/change propose` → `review` → `implement` cycle with every integration above lit up costs under a cent in Jev calls.** That is roughly 1.5% of the *planning phase alone*, before counting builders, reviewers, or verification.

### 7.3 Where the savings actually come from

The judgment calls themselves are a rounding error. The savings are the expensive things that don't happen:

| Avoided event | What it costs today | Gated by |
| --- | --- | --- |
| One false escalation to `architectural` | $0.27 + 2 agent round trips | §6.1 |
| One `already_satisfied` change that got planned anyway | $0.65 + a review + user time | §6.2 |
| One full re-review after a cosmetic edit | a 30-min high-thinking repo pass | §6.4 |
| One reviewer re-run for malformed JSON | a second full review | §6.8 |
| One builder run on a badly-packed capsule | a builder session + verification + review + repair | §6.3 |
| One bad task spec discovered at build time | a builder session + repair, sometimes a re-plan | §6.9 |
| One repair attempt past the point of progress | a builder session | §6.6 |
| One reviewer child on a trivially-safe task | a reviewer session | §6.5B |

I am deliberately not putting a headline percentage on this. The honest statement is structural and strong enough on its own:

> **Today every expensive stage is unconditional or gated by a regex. After this, every expensive stage is gated by a calibrated judgment that costs about 0.05% of the stage it gates.**

The right way to get the real number is §9.3: shadow mode, which measures the savings before you take them.

---

## 8. What Jev must not be used for

Stated explicitly, because the temptation will be real once the client exists.

- **Lifecycle transitions.** `assertLifecycleTransition`, `createChangeSnapshot`, `state-precedence.ts`. This is Muster's thesis. (I1)
- **Digests, hashing, git identity, worktree safety, writer leases.** Deterministic facts. Nothing to judge.
- **Arithmetic, counting, dates.** Jev is documented as unreliable at all three. Token budgets, cost forecasts, `BudgetLedger` math, failure-attempt counting, and timestamp comparison stay in code. Where a count over items is genuinely needed, ask one question per item and sum in code — that is what §6.2 and §6.9 do.
- **Generating anything.** Proposals, specs, task text, code, findings text, commit messages. Jev is not trained to generate and the docs say so plainly. Where a bounded value must be extracted, have code produce the candidates and let Jev pick (§6.8).
- **Weakening an existing deny.** `classifyProhibitedCommand`'s patterns and the git-subcommand allowlist are floors, not inputs. (I2)
- **Anything where a wrong "allow" is unrecoverable** unless the fail-safe direction is preserved — which in practice means: if uncertainty should cost money, gate on confidence; if uncertainty could cost data, don't use a probability at all.
- **Score interpolation as a measurement.** The jaggedness page is explicit: a `Score` expectation is fine for a threshold, but do not reconstruct a magnitude by interpolating between levels. Every gate above thresholds; none interpolate.

---

## 9. Testing and calibration

### 9.1 Hermetic by default

Muster's test suite spawns no network. That must not change. `src/judgment/record.ts` provides record/replay: fixtures keyed by `(decision, hash(state), hash(questions))`, stored under `tests/fixtures/judgment/`. Unit tests inject a replaying client. A fixture miss in CI is a test failure, never a live call.

### 9.2 Fallback tests are mandatory, not optional

Every call site gets a test that injects a client returning `{ available: false }` and asserts **byte-identical behavior to today**. This is how I3 stays true as the code evolves. It is also the cheapest possible insurance against the entire integration becoming a liability during an outage.

### 9.3 Shadow mode first — measure before you save

Ship every Tier 1 integration behind `MUSTER_JEV_MODE=shadow` before `=enforce`:

- Jev runs, its answers and confidences are recorded in the run store next to the decision.
- **The gate does not act.** Muster does exactly what it does today.
- Telemetry reports the counterfactual: how often would the gate have skipped the expensive stage, and what would it have cost if that skip was wrong.

After a few dozen real changes you have a labelled corpus — Jev's answer versus what the expensive stage actually concluded — and you can set thresholds from data instead of from the round numbers in this document. Every threshold above (0.7, 0.8, 0.85) is a starting point, not a recommendation.

Shadow mode also answers the question that decides §6.4's fate: **how often does a "cosmetic" edit turn out to change a review verdict?** If the answer is "never in 80 changes," enable it. If it's "twice," don't.

### 9.4 Calibration harness

A small script — `scripts/judgment/calibrate.ts` — that replays a fixture corpus, plots confidence against agreement-with-the-expensive-stage per decision, and prints the threshold that hits a target error rate. This is the thing that makes the numbers in this document real, and it should exist before `enforce` is the default anywhere.

---

## 10. Security and privacy

Jev is a **new third-party egress point for repository content**, and `docs/security.md` must say so before any of this ships.

**What leaves the machine, per call site:**

| Call site | State sent |
| --- | --- |
| §6.1 complexity | the user's prompt, preflight evidence paths and reasons |
| §6.2 preflight | the user's prompt, retrieved source excerpts |
| §6.3 packing | task contract, slice excerpts (source, specs, dependency reports) |
| §6.4 review triage | planning artifact text and its diff |
| §6.5 task review | task contract, diff summary, test output, scopes, TDD evidence |
| §6.6 thrash | failure evidence, which may include stderr |
| §6.7 commands | executable, argv, relative cwd |
| §6.8 extraction | reviewer prose |
| §6.9 task quality | change summary, requirements, scenarios, task metadata |

Required before enabling:

1. **Opt-in.** `MUSTER_JEV_API_KEY` **and** `MUSTER_JEV=1`. Absent either, the harness behaves exactly as today.
2. **Redaction on the way out.** `redactManualText` in `src/controller/manual-checkpoint.ts` already redacts bearer tokens, `--password`/`--token`/`--api-key` flags, and `key: value` secret patterns. Route every Jev `state` through it. §6.6 in particular ships stderr, which is where secrets leak.
3. **No secrets by construction.** Never send `.env`, credential files, or `process.env` as state, regardless of redaction. Enforce with a path denylist in `ask.ts`, tested.
4. **Document the data posture.** TypeSafe states that Jev is not trained on customer requests or responses, and that zero data retention is available to enterprise customers. If Muster is used on proprietary code, ZDR is the configuration to ask for, and `docs/security.md` should say which one you're on.
5. **Adversarial state is a real consideration.** Jev does not treat `state` as hostile. Repository content can be attacker-influenced (a dependency's README, a crafted test fixture). I2 is what makes this survivable: a Jev answer can only ever narrow permissions or spend more money. Nowhere in this proposal does a Jev answer unlock a capability.

---

## 11. Rollout

Muster's own workflow is the right vehicle. Each of these is one `/change`, in order, and each is independently shippable and independently revertable.

| # | Change | Scope | Gate to ship |
| --- | --- | --- | --- |
| 1 | `judgment-layer` | `src/judgment/**`, usage/budget wiring, record-replay harness, `docs/security.md` section | All fallback tests green with a dead client |
| 2 | `judgment-complexity` (§6.1) | `planning.ts` complexity inputs | Shadow-mode agreement measured across ≥20 changes |
| 3 | `judgment-preflight` (§6.2) | `planning.ts` preflight | Shadow mode; `already_satisfied` precision ≥ 0.9 |
| 4 | `judgment-capsule-ranking` (§6.3) | `context/assembler.ts` | Context-escalation rate drops or holds |
| 5 | `judgment-task-review-focus` (§6.5A) | `task-steps/review.ts` | Reviewer finding counts hold or improve |
| 6 | `judgment-command-classification` (§6.7) | `host-runner.ts` | Zero regressions in `broker-host-adversarial.test.ts` |
| 7 | `judgment-review-extraction` (§6.8) | `planning-reviewer.ts` | Extraction agrees with a retry on a fixture corpus |
| 8 | `judgment-task-quality` (§6.9) | `planning.ts` post-synthesis | Findings correlate with real build failures |
| 9 | `judgment-thrash-detection` (§6.6) | `policies/debugging.ts` | Escalations land at or before the old threshold |
| 10 | `judgment-review-triage` (§6.4) | `controller/review.ts` | Flag-gated, `proposal.md`/`design.md` only, N≤3 |
| 11 | `judgment-model-routing` (§6.12) | `model-router.ts` | Flag-gated; task success rate holds |

Changes 1–3 are the ones worth doing first regardless of what happens to the rest: the layer, and the two decisions that currently gate the most money behind the weakest evidence.

There is a pleasing self-reference here. The first real use of `/change propose` on this proposal exercises §6.1 and §6.2 against their own implementation.

---

## 12. Open questions

1. **Who runs Jev — the harness or the child agents?** This proposal puts it entirely in the harness, in TypeScript, in `src/judgment/`. The alternative is exposing a `muster_judge` tool to child agents so a builder can ask cheap questions mid-run. That is interesting (it would let a builder check "is this file in my write scope?" for a hundredth of a cent instead of reasoning about it) but it reintroduces the thing Muster avoids: a model deciding its own next action. **Recommendation: harness only, for now.** Revisit once §9.3 has data.

2. **One call or several per phase?** Jev's own guidance is unambiguous — batch everything that shares a state, since answers are independent and batching was measured at 12.2× cheaper and 10× faster. But Muster's phases compute state incrementally (preflight evidence → complexity → task parsing). The clean split is one call per *state*, not per *phase*. §6.1 and §6.2 should probably merge into one call once preflight retrieval moves into code.

3. **Does the 32k state budget bind?** State plus the longest single question must fit in 32k; state plus *all* questions in 64k. For §6.3 with many large slices, and §6.9 with a large `tasks.md`, this will bind. Excerpting (600 bytes per slice) is the answer, but excerpt-length-versus-ranking-quality is an empirical question for the calibration harness.

4. **Where do thresholds live?** `src/judgment/gates.ts` as constants is the proposal. The alternative — the `--fh-config` YAML, alongside model slots — is more flexible and lets a user trade rigor for cost per project. Probably the right end state; constants first.

5. **Is §6.4 worth the risk at all?** It is the largest recurring saving and the only integration that touches a correctness gate. It may be that the right answer is "no, review is cheap relative to being wrong about a spec." Shadow mode decides this, not this document.

6. **Pinned version upgrades.** I5 says pin `jev-1.13.0`. That means every model bump is a deliberate change with a re-calibration pass. Worth building the calibration harness (§9.4) so that upgrade is a script, not a project.

---

## 13. References

**TypeSafe / Jev documentation**

- Introduction — https://docs.typesafe.ai/introduction
- System One — https://docs.typesafe.ai/concepts/system-one
- How to build with TypeSafe — https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- State — https://docs.typesafe.ai/concepts/state
- Primitives — https://docs.typesafe.ai/primitives (and `/choice`, `/score`, `/noul`, `/advanced`)
- Confidence — https://docs.typesafe.ai/confidence
- Patterns — https://docs.typesafe.ai/patterns (`/fan-out`, `/confidence-routing`, `/composite-scoring`, `/intent-routing`)
- **Jev 1.13 jaggedness** — https://docs.typesafe.ai/model-jaggedness/jev-1.13 *(read this before writing any question)*
- Models and pricing — https://docs.typesafe.ai/models
- HTTP API — https://docs.typesafe.ai/api
- JavaScript SDK — https://docs.typesafe.ai/sdk/javascript
- Agent skill — https://docs.typesafe.ai/agent-skill

**Cookbooks cited for measured numbers**

- Parallel questions (12.2× cheaper, 10.0× faster) — https://docs.typesafe.ai/cookbooks/parallel_questions
- Re-ranking (top-1 5%→18%) — https://docs.typesafe.ai/cookbooks/rerank_typesafe
- Skill suggestion (wrong loads 16.8%→7.3%) — https://docs.typesafe.ai/cookbooks/skill_suggestion
- Classifying RAG passages — https://docs.typesafe.ai/cookbooks/classifying_rag_passages
- Pre-parsed value extraction — https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook
- Date extraction (the extract-in-model, compute-in-code split) — https://docs.typesafe.ai/cookbooks/date_extraction_cookbook

**Muster files this proposal touches**

`src/change/phases/planning.ts` · `src/controller/complexity-router.ts` · `src/context/assembler.ts` · `src/context/escalation.ts` · `src/controller/review.ts` · `src/review/artifact-digest.ts` · `src/review/planning-reviewer.ts` · `src/review/code-review.ts` · `src/change/phases/task-steps/review.ts` · `src/policies/debugging.ts` · `src/tools/host-runner.ts` · `src/controller/manual-checkpoint.ts` · `src/change/failure-classification.ts` · `src/agents/model-router.ts` · `src/telemetry/budget.ts` · `src/telemetry/usage.ts` · `docs/security.md`
