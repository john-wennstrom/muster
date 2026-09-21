## Context

`runProductionPlanning` currently: builds a judgment runtime, optionally retrieves candidates and asks `planning.preflight`, runs the preflight agent unless judgment acted, creates the change if needed, resolves risk inputs (pattern baseline merged with `planning.complexity` answers), calls `classifyChange` on the preflight evidence paths, then calls `orchestrationPolicy(classification)` whose `mandatory` fields are constant. `classifyChange` scores seven signals (file count, capability count, cross-capability, public contract, data migration, security boundary, design ambiguity) into `direct`, `bounded` or `architectural`. `patternRiskInputs` derives the four risk booleans from regular expressions over the request, and `mergeRiskInputs` lets a confident judged value replace one pattern value.

The complexity decision also asks two questions that are recorded and never acted on: whether the change is mechanical, and a four-level reach rubric.

## Goals / Non-Goals

**Goals:**

- The lane is known before the first agent session and recorded once.
- One Jev request replaces two, sending no more than either sent.
- Without Jev nothing gets cheaper and nothing gets riskier: the lane is medium or large.
- Later changes can key behavior off the lane through one declared table.

**Non-Goals:**

- Making small changes cheaper. That is changes 05 and 06. Here small and medium behave identically apart from what is recorded.
- Removing the preflight agent. It stays as the fallback until change 05 folds its job into the planning session.
- A fourth lane, or lanes for commands other than propose and refine.

## Decisions

### 1. The lane record

`lane.json` under the change's run store: `{ schemaVersion, lane, source: "user" | "judgment" | "pattern", reasons: string[], escalations: [{ from, to, reason, at }], decidedAt }`. `escalateLane(store, change, to, reason)` appends to `escalations` and raises `lane`, and refuses a move that is not strictly upward. The snapshot loader reads it; a missing file means `medium`. Status shows `Lane: small (judgment)` plus the escalation count.

Rejected alternative: storing the lane in the run manifest. The manifest is created at implementation, and the lane exists from planning.

### 2. One decision

`change.triage` takes the request text (on refinement including the previous review's required changes, as preflight does), the phase, and up to ten code-retrieved candidates with path and a 600-byte excerpt. It asks:

- `disposition`: choice of `proceed`, `needs_clarification`, `already_satisfied`.
- Two questions per candidate: does it implement the request, does it need to change for it (both worded as in the removed preflight decision so a file that merely shares names is not evidence).
- The four risk questions (public contract, data migration, security boundary, design ambiguity, the last applied only in refinement).
- `mechanical`: noul.
- `reach`: the four-level rubric.

Its state is the union of what the two removed decisions sent, so egress does not grow and one request replaces two. Its effects are `adds_caution` and `reduces_work`. It runs in shadow or enforce like any decision.

### 3. Choosing the lane

A pure function `chooseLane` takes the pattern classification (over candidate paths, not agent evidence), the judged answers if any, the phase, and an optional user choice.

1. A user choice wins.
2. Start from the pattern lane: `direct` → medium, `bounded` → medium, `architectural` → large. Small is not reachable from the pattern alone, because a regex over the request is too weak to be the only evidence for doing less.
3. Judged risk answers merge as they do today (one input at a time, confident answers only). A confident yes on any risk raises the lane exactly as the classifier would.
4. Small only when, after merging, the classification is `direct`, all four risk answers were judged and are no, and reach was confidently one of the two lowest levels.
5. Any uncertainty leaves the lane where step 2 and 3 put it.

The reasons list records which answers decided it, so a wrong lane can be audited.

### 4. Ordering and the fallback agent

Propose and refine do, in order: retrieve candidates (code, no LLM), ask triage, choose the lane, write `lane.json`, then handle disposition. A confident enforce-mode `proceed` skips the preflight agent, and a confident corroborated `already_satisfied` blocks without it, exactly as the removed preflight decision did. `needs_clarification` never acts: the agent runs, because writing the question is its job. Unavailable or unconfident triage runs the agent. The lane is already chosen by then, from the pattern and any confident answers, and does not wait for the agent. This removes the dependence of the size decision on an agent session.

The affected-file input to `classifyChange` therefore changes source: candidate paths from retrieval instead of the agent's evidence. With judgment off, retrieval still runs (it is code and sends nothing), so the pattern lane uses real file counts.

### 5. Lane policy is one table

```
LANE_POLICY = {
  small:  { specialistOpinions: 0, debate: false, reducesWorkAllowed: true  },
  medium: { specialistOpinions: 0, debate: false, reducesWorkAllowed: true  },
  large:  { specialistOpinions: 2, debate: true,  reducesWorkAllowed: false },
}
```

Planning reads opinions and debate from it, replacing `orchestrationPolicy`. Optional stages still subject to the budget forecast as today. `reducesWorkAllowed` is consumed by later changes: a decision that skips work checks it, and large never skips. Later changes add fields to this table rather than new switches elsewhere.

### 6. The user override

`/change propose <change> [lane=<lane>] <goal>` and the same for refine. The lane is a plain argument word, not a flag, and it is recognised only as the word immediately after the change name, so a goal that happens to start with the word small is never misread. The handler removes it from the prompt text, validates it against the three names, and never sends it to a model. An invalid value blocks with the usage line. An explicit lane is recorded with source `user` and skips the triage call entirely, since its answer would not be used, saving a request. Disposition then falls to the agent, as when judgment is unavailable.

### 7. Shadow mode

In shadow mode triage is asked and recorded, the pattern lane is used, and the record notes the lane it would have chosen. Reconciliation later stores whether the lane escalated, so a shadow period yields a measure of how often small would have held.

## Risks / Trade-offs

- **A wrong small lane skips a check that mattered** -> Small is unreachable without confident answers to every risk and reach, and later changes only reduce LLM steps, never deterministic gates. Escalation is one way and is triggered by lint, task outcome and recovery decisions.
- **Candidate paths undercount a change's reach** -> They are a floor on files, and the risk questions and reach carry the rest. A user can override upward with `lane=large`.
- **Pattern regexes misfire** -> They can only raise the lane, never lower it, and judged answers replace them one input at a time when confident.
- **Small and medium are identical for a while** -> The lane and its audit trail exist and accumulate shadow data before behavior depends on them.

## Migration Plan

Add the lane module and the decision with tests, wire planning, remove the two old decisions and the policy function, then add status output and documentation. Changes with no `lane.json` read as medium. Rollback is a revert.
