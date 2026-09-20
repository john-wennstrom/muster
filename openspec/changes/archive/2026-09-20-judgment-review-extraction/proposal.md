## Why

A planning review is a high-thinking, read-only pass over the whole repository by a frontier-model agent, with a thirty-minute ceiling. Its result must be one structured object: a verdict and three lists of findings. Reviewers sometimes spend their turn reasoning and never emit the object, or write their findings as prose. When that happens the harness sends a corrective message into the same session and asks again, spending another high-thinking turn to obtain, in a parseable shape, conclusions the reviewer has in many cases already written out in words.

That retry is spent on formatting. Most of what the reviewer wrote is recoverable: its bullet points and short paragraphs are the findings, and the only judgment left is a narrow one — which lines are blocking problems, which are recommendations, and which are narration — plus what verdict the text as a whole reaches. Code can find the candidate lines; a typed judgment can classify them; and the result can be assembled from the reviewer's own words without generating anything.

## What Changes

- When a reviewer's response is not valid structured output at all, extract candidate lines from it with a deterministic parser and classify them, together with the response's overall verdict, with one typed judgment — before sending a corrective retry, and on the final attempt before failing the review.
- Assemble the review from the reviewer's own lines, verbatim apart from whitespace, so nothing is generated.
- Accept an extraction only when the verdict is confident and not unclear, every candidate line is confidently classified, and the verdict is consistent with the findings in both directions: an approval has no blocking line and a revise has at least one. Anything else retries exactly as today.
- Mark an extracted review in the persisted review artifact and reference its decision record, so the provenance is explicit; artifacts without the mark remain valid.
- Leave responses that are valid structured output untouched, and never judge them.
- Run first in shadow mode, comparing the extraction with the retry's result.
- With judgment unavailable or disabled, behave exactly as today.

## Capabilities

### New Capabilities

- `judgment-review-extraction`: How a planning review whose reviewer did not return the required structured object is recovered by classifying the reviewer's own words instead of asking again, and how such a recovered review is marked.

### Modified Capabilities

None.

## Impact

- **Reviewer runner:** an extraction attempt on an unparseable response, ahead of the corrective retry and ahead of final failure.
- **Review artifact:** an optional provenance mark that is rendered and parsed; existing artifacts and consumers are unaffected, and verdicts and digests are unchanged.
- **Cost:** about $0.0003 per extraction, against the retry it replaces. The retry continues the same session, so its cost is a further high-thinking turn with the session's context rather than a fresh review; the recorded outcomes measure how often it happens and what it costs.
- **Limit:** if the reviewer produced no findings text at all — pure reasoning with no conclusions — there is nothing to classify and the retry still happens. This removes the common case, not every case.
- **Egress:** the reviewer's response text. Documented in the security documentation.
- **Rollout gate:** extraction agrees with a retry on a fixture corpus of recorded reviewer responses, and shadow-mode agreement is reviewed before enforce is used.
- **Ordering:** depends on `judgment-layer`, and on the reviewer retry loop and the submission schema that are staged but uncommitted in the working tree at the time of writing. Independently revertable.
