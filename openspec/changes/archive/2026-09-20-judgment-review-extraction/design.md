## Context

See `proposal.md` for motivation. The planning reviewer runner sends the review prompt plus a fixed output contract to a read-only reviewer, then tries to parse the reviewer's text as JSON and validate it against the review submission schema: a verdict, and three lists of single-line strings, with an approval forbidden from carrying critical findings or required changes. If parsing or validation fails, the runner builds a correction message and asks the same session again, up to two attempts in all, then raises an invalid-review error. The retry continues the same session, so it is a further high-thinking turn that starts with everything the reviewer has already read, not a fresh review. The dispatcher then audits the reviewer's tools and validates the submission again, and the review controller stamps the controller-owned fields — round, time, model, and the artifact digest — and writes the review artifact.

The retry loop and the submission schema exist in the working tree, staged but not committed, at the time of writing. This design assumes they land first.

The review artifact has a strict schema and a line-oriented rendering: fixed metadata lines, then three sections. Every consumer that reads it — lifecycle snapshot, verification, refine — reads the verdict, digest, and required changes.

The judgment layer supplies typed decisions, shadow and enforce modes, audit records, and a fallback for every unavailable reason.

## Goals / Non-Goals

**Goals:**

- Recover the common case — findings written as prose — without a second reviewer turn.
- Make provenance explicit, and make a wrongly accepted approval as unlikely as the design can make it.
- Leave everything downstream of the submission — tool audit, validation, digest binding, lifecycle — untouched.

**Non-Goals:**

- Generating or rewording any finding. Extraction selects and classifies the reviewer's lines.
- Deterministic recovery of a JSON object wrapped in a fence or in prose. That is a separate improvement, noted below.
- Changing the reviewer's prompt, its output contract, its thinking level, or its timeout.

## Decisions

### 1. Extraction is for responses that are not valid structured output

When the text parses as JSON but fails the schema — for example an approval that lists required changes — the reviewer has contradicted itself, and no classification of its lines resolves which half was meant. Those responses retry, as today. Extraction applies only when the text is not valid structured output at all.

### 2. Candidate lines come from a deterministic parser

A pure function splits the response into candidates: list items — bulleted or numbered — with their indented continuation lines joined, and standalone paragraphs, each carrying the nearest preceding heading, since a heading such as "Required changes" is strong context for a line beneath it. It strips list markers, normalizes whitespace to a single line, and enforces the caps of 60 candidates and 400 characters. Because the schema requires single-line strings, normalization is what makes a verbatim line a valid finding.

### 3. Two kinds of question over one state

The state is the reviewer's response, capped at 24,000 bytes, and the candidate list. One question asks for the verdict the response as a whole reaches, with options approve, revise, and unclear, each defined in terms of whether a blocking problem is raised. One question per candidate asks how the line functions — a defect that blocks the plan, a change that must be made before implementation, an optional improvement, or narration, restatement, or preamble. The service classifies; it writes nothing.

### 4. Acceptance is strict and symmetric

The gate accepts only when the verdict is confident and not unclear, every candidate line is confidently classified, and the verdict is consistent with the lines in both directions. Consistency in the approval direction is the safety-critical one, because a false approval lets a flawed plan proceed, whereas a false revise costs one refine cycle. Requiring every line to be confidently classified, for both verdicts, is simpler than a graduated rule and errs toward the retry. Shadow data may later justify relaxing the revise side.

Confidence bars are constants beside the gate and are starting points.

### 5. Provenance is an optional line in the review artifact

The review artifact gains an optional field naming the decision record that produced it, rendered as one extra metadata line and parsed by an optional-line reader beside the existing required-line reader. Verdict, digest, and every list are unaffected, so all consumers work unchanged, and artifacts written before this change parse as not extracted. The verdict remains the reviewer's, taken from its own words; the mark tells a reader how the words became a structure.

### 6. The runtime rides the existing request chain

The reviewer request, the dispatch options, and the review controller input each gain an optional judgment runtime; the review phase supplies it. The runner returns an extraction marker with the review, the dispatcher passes it through, and the controller writes it into the artifact. Everything the dispatcher does after the runner — the tool audit and schema validation — applies to an extracted review exactly as to a parsed one.

### 7. Shadow reconciles with the retry

In shadow mode the runner records the extraction and runs the retry as today. When the retry's result is known, the record is reconciled with its verdict and its count of blocking findings; agreement means the same verdict. The retry's findings are freshly written and will not match the extracted lines verbatim, so agreement is measured on verdict and blocking presence, not on text. The rollout gate also uses a fixture corpus of recorded reviewer responses with their expected structure, which tests replay against the extraction.

### 8. The decision declares one effect

Acting reduces work: it skips a retry. It falls through to the retry whenever it abstains.

### 9. Deterministic fence recovery is a separate follow-up

Many failures are a valid JSON object inside a code fence or surrounded by prose, and a deterministic scan would recover them without any model. It is left out of this change on purpose: it would change the runner's behavior with judgment disabled, which this change promises not to do. It is probably the cheaper fix for that specific failure, and worth doing on its own.

## Risks / Trade-offs

- **A wrongly accepted approval** → Confident verdict, every line confident, two-way consistency, an explicit provenance mark, and shadow measurement first.
- **The response is reasoning with no findings text** → Nothing to classify, so the retry happens. Stated as a limit.
- **Findings written as prose paragraphs the parser merges or splits badly** → The fixture corpus covers shapes seen in practice, and any extraction the parser mishandles tends to produce uncertain classifications, which retry.
- **Markdown noise inside lines** → Normalization removes list markers and whitespace only; other markup is left as written so lines stay verbatim.
- **The baseline is in flux** → This change is written against the staged retry loop and schema and should be implemented after they land.
- **Artifact schema change** → The new field is optional in both directions and covered by round-trip and old-file tests.

## Migration Plan

1. Add the candidate parser and the assembly and acceptance logic with their tests.
2. Register the decision.
3. Add the optional provenance field to the review artifact, with round-trip and older-file tests.
4. Wire extraction into the reviewer runner, thread the runtime and marker through the dispatcher, controller, and review phase, and add shadow reconciliation.
5. Build the fixture corpus and the agreement report, add the documentation row, and run the full validation set.

Rollout: shadow first, collecting the acceptance rate and verdict agreement, and replaying the corpus; enforce only when extraction agrees with the retry on the corpus and the shadow disagreements are reviewed. Rollback: unset the enabling flag, or revert, which restores the retry-only behavior. Reviews already marked as extracted remain valid.

## Open Questions

- Whether to relax the revise side to accept a review when only some lines are uncertain, once shadow data exists. It would loosen the acceptance requirement, so it would be a specification change at that time.
