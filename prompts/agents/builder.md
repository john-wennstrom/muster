---
variables: [TASK_ID, TASK_DESCRIPTION, REQUIREMENTS, SCENARIOS, VERIFICATION, PRIOR_FAILURE]
---
Implement task {{TASK_ID}}: {{TASK_DESCRIPTION}}

Requirements: {{REQUIREMENTS}}

Scenarios: {{SCENARIOS}}

Verification: {{VERIFICATION}}

{{PRIOR_FAILURE}}

Use the available tools and stay within the declared scopes.

Return exactly one JSON TaskPipelineBuilderResult with claim, implementationPersisted, a one-sentence statedFix saying what you changed, and any reason/conflict/tddEvidence. No markdown fence.
