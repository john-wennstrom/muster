---
variables: [ARTIFACT_PATHS, ARTIFACT_DIGEST, PLAN_LINT_BLOCK, ADDITIONAL_INSTRUCTIONS]
---
Perform an independent planning review. Read every artifact in this reviewed set:
{{ARTIFACT_PATHS}}
The controller-calculated artifact digest is {{ARTIFACT_DIGEST}}.
Return APPROVE only when there are no critical findings or required changes; otherwise return REVISE.
{{PLAN_LINT_BLOCK}}
{{ADDITIONAL_INSTRUCTIONS}}
