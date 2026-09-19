## Context

See `proposal.md` for motivation. Today preflight forecasts a mandatory budget line for the agent, then runs it in the restricted brokered mode with a six-call cap, then parses exactly one JSON object with a schema requiring a disposition, a non-empty summary, at most eight evidence entries (each a path and a non-empty reason), and a question when clarification is needed. Two workarounds exist for unreliable output: one strips an empty question field before validation, and one scans free text for a balanced JSON object. A non-proceed disposition returns a blocked outcome carrying the summary, the evidence, and a question — for already-satisfied, a standard question about which branch, deployment, or entry point still fails.

The planning options already carry an injection point for the preflight runner, which tests use. The complexity decision from the previous change consumes the preflight's evidence paths as its affected files.

The judgment layer supplies typed decisions, shadow and enforce modes, audit records, and a fallback for every unavailable reason. This change adds a retrieval library, one decision, one composition step, and one call site.

## Goals / Non-Goals

**Goals:**

- Skip the agent where judgment can produce the whole outcome and be confident about it.
- Improve the agent's use of its limited tool calls where judgment is available but not confident.
- Leave the agent path — its prompt, cap, parsing, and hardening — byte-for-byte what it is today when judgment is unavailable, disabled, or in shadow mode.
- Make the disposition's agreement with the agent, and the precision of already-satisfied, measurable before enforce is used.

**Non-Goals:**

- Generating any text with judgment. Summaries and reasons composed by code are templates over structured answers.
- Changing the disposition vocabulary, the blocked outcome, or the standard question.
- Retrieval that uses a model, an index, or an external search tool.
- Removing the output-parsing hardening; it stays for the fallback path.

## Decisions

### 1. Retrieval is a small library over the existing Git adapter

Retrieval extracts identifiers and paths from the request — explicit paths, backticked or quoted identifiers, and camel-case, snake-case, and kebab-case tokens, with common words filtered and the count capped — then searches the repository's eligible files and ranks files by how many distinct terms they match, breaking ties by path so results are deterministic. The excerpt for a file is a window around its first matches, cut to the byte cap.

It uses the same eligibility rules as the broker's search tool — tracked and non-ignored untracked text files, a size ceiling, and dependency directories and run logs excluded — implemented over the existing Git adapter, so there is no dependency on an external search program that some machines lack. It lives with the context libraries, imports the judgment layer only for the credential denylist, and is called by the planning phase. Each candidate's path is declared to the layer.

Alternative considered: keep using the agent for retrieval and judge only its findings. Rejected because retrieval is the agent's cost, and the point is to skip the agent.

### 2. Only proceed and corroborated already-satisfied act directly

The proposal's draft gate acted on any disposition at 0.80. That cannot hold for clarification: the question is the entire product of that outcome, and judgment does not write text. A generic templated question would be a visible regression from the specific question the agent writes today. So clarification is excluded from direct action. A judged needs-clarification still improves the agent run by pre-loading candidates, and it is recorded for agreement measurement, but the agent writes the question.

Alternative considered: a templated question from the ambiguity rubric level plus the candidate paths. Rejected for now as a regression in the one part of the outcome users read; it can be revisited from shadow data on how often clarification is judged.

### 3. Corroboration guards the blocking outcome

Already-satisfied stops the user's request. A single global answer is the weakest evidence for a blocking result, so the gate also requires at least one per-candidate answer above 0.7 that the candidate implements the request, and the per-candidate questions ask about implementing, not about mentioning or touching the same area. Proceed does not need corroboration: its failure mode is the failure mode of today's agent, a plan that later fails review.

The confidence floor of 0.80, the corroboration bar of 0.7, and the relevance floor of 0.5 for evidence are constants beside the gate and are starting points for calibration.

### 4. Composition is templated code over structured answers

The gate's outcome is structured: the disposition, the relevant candidates with probabilities, and the implementing candidates with probabilities. A pure composer in the controller layer turns it into the shape the phase already handles, so the rest of the phase cannot tell which path produced it. Evidence reasons state how the file was found — the matched terms — and the judged probability. The summary is a fixed sentence per disposition naming the count of candidates.

Composed reasons are terser than agent-written ones, and they flow into the planning prompts as authoritative context. Two things mitigate that: the synthesis agents have repository tools of their own, and the fallback path is taken whenever confidence is below the floor. The record marks whether each preflight was produced by judgment or by the agent, so the later planning-review outcome can be compared by path before the rollout gate is considered met.

### 5. Order of operations: retrieve, judge, then forecast only if the agent will run

When judgment is enabled, the phase retrieves candidates and asks. If the gate acts, the phase composes the result and never forecasts or runs the agent, so no preflight budget is consumed. Otherwise the phase makes the same mandatory budget forecast it makes today and runs the agent; a forecast that blocks still raises the same exhaustion error. When judgment is disabled, none of retrieval, the call, or any record happens and the phase is exactly today's.

### 6. Pre-loading candidates happens only when judgment answered

The agent's prompt gains a section listing candidate paths and excerpts when judgment was available and did not act. When judgment was unavailable, the prompt is identical to today's, so the fallback is provable by comparing prompts. In shadow mode the prompt is also identical to today's, so the counterfactual comparison is clean: the agent's disposition is what today would have produced.

### 7. Shadow reconciles with the agent's disposition

After the agent returns in shadow mode, the record is reconciled with the agent's disposition and its evidence paths. Agreement means the same disposition. A report helper computes agreement, the precision of already-satisfied, and how often the decision would have acted, so the rollout gate can be read off it. The overlap between judged-relevant paths and the agent's evidence paths is recorded but not gated.

### 8. The decision declares one effect

Acting reduces work: it skips a mandatory agent run. It therefore falls through to that agent whenever it abstains, which is every case other than the two acting cases.

## Risks / Trade-offs

- **The judgment is weak at "does this code already do that", which is a genuine indirection** → Excerpts instead of whole files, per-candidate questions, the 0.80 floor, corroboration, and the fact that already-satisfied yields a blocked outcome that is cheap, reversible, and user-visible.
- **Retrieval misses the relevant file** → A miss makes a confident already-satisfied unlikely (nothing to corroborate it) and makes a proceed no worse than a plan that later fails review, as today.
- **Terse composed evidence weakens downstream planning context** → Repository tools remain available to the synthesis agent, the fallback runs below the floor, and outcomes are comparable by path.
- **Source excerpts are the largest planning egress** → Redaction, the credential denylist, the excerpt and candidate caps, and documentation of the exact state sent.
- **A retrieval or judgment failure must never fail preflight** → Any error in either becomes a fallback to the agent.
- **Edits are in flight in the planning phase module** → Implement on top of them.

## Migration Plan

1. Add the retrieval library with its tests against a temporary repository.
2. Register the decision with its gate, and add the pure composer.
3. Wire retrieval, the call, the skip, the pre-load, shadow reconciliation, and the outcome marker into the planning phase.
4. Add the agreement and precision report.
5. Add the documentation row and run the full validation set.

Rollout: shadow mode on real planning runs; read agreement and already-satisfied precision after enough changes to have several confident already-satisfied cases; require precision of at least 0.9 before enforce. Rollback: unset the enabling flag, or revert, which restores the agent-only preflight.

## Open Questions

- Whether the candidate count and excerpt size should grow once calibration shows how accuracy varies with them. This affects only retrieval constants.
- Whether a templated clarification question could be acceptable once shadow data shows how often clarification is judged. This would change the specification if adopted, so it is deferred to a later change rather than assumed here.
