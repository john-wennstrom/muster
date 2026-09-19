## Why

Planning begins with a preflight that spawns a full architect agent in a restricted mode: at most six read or search calls, budgeted at 15,000 tokens and $0.08, with a thirty-minute ceiling. It must return exactly one JSON object naming a disposition — proceed, needs clarification, or already satisfied. Getting that object back reliably has already required a preprocessor for an empty question field and a brace-matching scanner, because the agent wraps its answer in prose.

Most of what the agent does is deterministic retrieval — find files that mention the request's identifiers and read a few lines of each. The judgment left over is narrow: does the code already do this, and is the request specific enough to plan? That judgment gates everything downstream. When the answer is "already satisfied" or "too ambiguous", a correct early answer prevents the entire chain that follows — synthesis, any specialist opinions, a review, and the user's time, roughly $0.65 — and today it is decided by the most fragile step in the pipeline.

## What Changes

- Move retrieval into code: extract identifiers and paths from the request, search the repository's eligible files, and take a bounded number of candidates with short excerpts.
- Make one judgment call over the request and those candidates, deciding the disposition and, per candidate, whether it already implements the request and whether it would need to change.
- Act directly only where judgment can produce the whole outcome. A confident proceed is composed by code from the candidates judged relevant. A confident already-satisfied that at least one candidate corroborates returns the same blocked outcome, with the same question, that the agent path returns today. In both cases the architect agent is not run.
- Never decide a clarification outcome from judgment alone. The clarifying question is the entire product of that outcome and judgment cannot write it, so the agent runs, with the candidates pre-loaded.
- When judgment is available but not confident enough to act, run the agent with the candidates pre-loaded so its limited tool calls are better spent.
- When judgment is unavailable or disabled, run the agent exactly as today — same prompt, same limits, same output hardening.
- In shadow mode, always run the agent and record how the judged disposition compares with the agent's.

## Capabilities

### New Capabilities

- `judgment-preflight`: How planning preflight decides whether a request should proceed, is already satisfied, or needs clarification — candidate retrieval by code, one typed judgment over the candidates, direct action only where judgment can produce the whole outcome, and the unchanged agent run as the fallback.

### Modified Capabilities

None.

## Impact

- **Planning phase:** preflight gains a retrieval step and a judgment call ahead of the agent run; the agent run, its parsing, and the blocked outcome it feeds are unchanged and remain the fallback.
- **Cost:** about $0.0004 per preflight against a $0.08 agent budget line, plus the downstream chain avoided when the early answer is already-satisfied.
- **Egress:** the request text and retrieved source excerpts with their paths — the largest planning egress, so redaction, the credential denylist, and the excerpt caps matter here. Documented in the security documentation.
- **Quality trade-off:** code-composed evidence carries terser reasons than agent-written evidence. The record marks which path produced each preflight so the later review outcome can be compared by path.
- **Rollout gate:** shadow mode first; already-satisfied precision of at least 0.9 against the agent's own disposition before enforce is used.
- **Ordering:** depends on `judgment-layer`. Independently revertable: reverting restores the agent-only preflight.
- **Coordination:** the planning phase module has edits in flight at the time of writing; implement on top of them.
