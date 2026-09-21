---
variables: [REVIEW_REQUEST, CORRECTION_BLOCK]
---
{{REVIEW_REQUEST}}

Return exactly one JSON object with only these fields — no markdown or code fence, no other fields, nothing before or after it:
{"verdict":"APPROVE"|"REVISE","criticalFindings":string[],"requiredChanges":string[],"recommendations":string[]}
criticalFindings, requiredChanges, and recommendations are arrays of single-line strings (use [] when there are none). verdict must be REVISE if either criticalFindings or requiredChanges is non-empty; otherwise APPROVE.

{{CORRECTION_BLOCK}}
