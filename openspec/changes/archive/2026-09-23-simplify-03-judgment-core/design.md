## Context

The layer's public surface is `askJev` (transport) and `judge` (ask, apply the decision's gate, record, return a verdict whose kind is `enforce`, `shadow` or `fallback`). Decisions are values built with `defineDecision`, carrying an id, a version, declared effects (`adds_caution`, `adds_advice`, `reduces_work`), an optional enabling variable, a representative input, a question builder and a pure gate. Audit records are written per decision and can be reconciled later with the outcome the ordinary path reached.

Call sites reach for it like this:

```
if (!runtime.enabled) return null;
try { verdict = await runtime.judge(...) } catch (e) { if (e instanceof JudgmentFixtureMissingError) throw e; return null; }
...
try { await reconcileDecisionRecord(store, change, verdict.recordId, {...}) } catch { /* measurement */ }
```

Tests use `createReplayClient`, keyed by decision, version and a hash of the canonical state and questions.

## Goals / Non-Goals

**Goals:**

- Each decision is readable in one short file. The shared machinery is small enough to hold in one head.
- A call site is two lines: ask, then use the verdict.
- Enforce works out of the box for operators who have opted in.
- Tests are hermetic without recorded data.

**Non-Goals:**

- Changing any decision's gate, confidence band or egress. Later changes add or replace decisions.
- Changing the transport, the egress checks, the redaction or the pinned model.
- Making judgment on by default. It stays opt-in through the flag and a key.

## Decisions

### 1. Layout

```
src/judgment/
  client.ts  egress.ts  policy.ts  audit.ts  usage.ts   (unchanged responsibilities)
  ask.ts        askJev and judge
  try.ts        tryJudge
  decision.ts   Decision type, defineDecision, act/abstain, effects, band helpers
  questions.ts  noul/choice/score helpers, validation, fingerprint
  catalog.ts    the list of decisions, validateCatalog
  summary.ts    the generic per-decision summary (moved out of audit if it lives there)
  decisions/<name>.ts   one decision each
```

A decision module exports the decision value plus, where the call site needs them, its state builder and presenter. It imports `decision.ts` and `questions.ts` and nothing from phases. The existing layering test continues to enforce that the layer calls nothing back.

### 2. `tryJudge`

```
tryJudge(runtime, decision, request): Promise<Verdict | null>
```

Returns `null` when judgment is disabled, and a `fallback` verdict is folded into `null` too, because every caller treats "no usable answer" the same way: do what you do without judgment. It never throws for an operational failure. The verdict it returns has `kind` (`enforce` or `shadow`), the gate outcome, and `reconcile(observed, agreed?)`, a method that merges observations into the record and never throws. Callers that need the reason for a fallback (usage reporting) read it from the record, not from an exception.

Rejected alternative: keep `judge` and let call sites wrap it. That is the boilerplate being removed.

### 3. Scripted client instead of recordings

`tests/helpers/scripted-judgment.ts` exports `createScriptedClient(script)`, where the script maps a decision id to either a fixed answer set or a function of the request that returns answers by question identifier, and `createDeadClient(reason)` for the unavailable paths (one per unavailable reason). A request the script does not cover fails the test with an error naming the decision, so a test cannot pass by accident when nothing answered. There is no hash keying, no version keying and no recorder.

What this gives up: recordings carried real response shapes and real answers, so they guarded against wording that the live service reads differently from what the author intended. Two things replace that guard. The transport keeps one test that parses a canned response body in the service's real shape, and a manual probe script (`bun run judgment:probe`) sends each decision's representative input to the live service and prints the answers and the gate outcome. The probe is a human tool, never part of CI, and is the way to check wording after a change to a question file.

### 4. Enforce by default, no per-decision flags

`resolveJudgmentPolicy` returns mode `enforce` when the mode variable is unset. `MUSTER_JEV_MODE=shadow` selects shadow; any other value stays invalid configuration. The opt-in is untouched: `MUSTER_JEV=1` and a key are both required, and with either absent nothing is sent.

The `decisionFlag` parameter and the `enabledBy` field are removed. Review triage no longer needs `MUSTER_JEV_REVIEW_TRIAGE`: retention of the approved proposal and design prose is local (at most three copies per change under the run store) and only happens when judgment is enabled. Routing no longer needs `MUSTER_JEV_MODEL_ROUTING`: it is inert without `MUSTER_BUILDER_ECONOMY_MODEL`, which is real configuration that names a model.

Safety does not rest on the default. A decision that can reduce work still needs confident answers to act and abstains into the full activity otherwise, and no effect in the vocabulary can grant a permission or remove a manual checkpoint.

### 5. Reports

The seven per-decision report modules compute agreement figures that the per-record `agreed` field and the generic summary already carry. They are deleted. `/change status` gains a short judgment block from the generic summary: calls, acted, would-have-acted, unavailable by reason, agreement over reconciled records. It prints nothing when there are no records.

### 6. Capsule ranking

The decision, its question wording, its tests, and `src/context/ranking.ts`, `escalation.ts` and `assembler.ts` are deleted. `src/context/candidates.ts` stays: planning retrieval uses it and change 04 keeps using it. Nothing calls the deleted modules today. If context ranking is wanted later it returns as a new decision with a call site that exists.

### 7. Order of work inside this change

Add the scripted client and `tryJudge` beside the existing machinery. Convert tests to the scripted client. Only then delete replay, and migrate call sites to `tryJudge` in the same step that removes the missing-recording handling. Split the decisions into modules in three groups (planning, review, execution). Delete capsule ranking and the reports. Flip the default and remove the flags last, with the documentation.

## Risks / Trade-offs

- **Enforce by default surprises an operator who set the flag long ago** -> Called out under Impact and in the README; shadow is one variable away. Every acting decision has a confidence floor and a full-activity fallback.
- **Scripted answers can drift from what the service returns** -> The canned-payload transport test guards the shape; the probe script guards wording, on demand.
- **Splitting a 1,275-line file risks subtle constant drift** -> Each decision moves with its tests in one step, and the prompt goldens from change 02 still assert the questions are unchanged.
- **Removing flags loosens a guard on retention** -> Retention is local, bounded and only under judgment; documented in the security model.

## Migration Plan

Additive pieces first, conversions second, deletions third, behavior flips last. Each task leaves the suite passing. Old decision records in existing run stores are read as before but are not migrated. Rollback is a revert.
