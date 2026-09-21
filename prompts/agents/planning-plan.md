---
variables: [CHANGE_NAME, USER_REQUEST, LANE_GUIDANCE, LANE_TASK_LIMIT, AUTHORITATIVE_CONTEXT, DISPOSITION_NOTE, CURRENT_ARTIFACTS, REQUIRED_CHANGES, PRIOR_ANALYSIS, PLAN_SCHEMA, VALIDATION_FAILURES]
---
Plan the requested change. Code validates your answer and renders every OpenSpec artifact from it, so you return a plan as data and never write artifact files or paths.

Change: {{CHANGE_NAME}}

User request: {{USER_REQUEST}}

{{LANE_GUIDANCE}}

Use at most {{LANE_TASK_LIMIT}} tasks.

Authoritative context: {{AUTHORITATIVE_CONTEXT}}

{{DISPOSITION_NOTE}}

{{CURRENT_ARTIFACTS}}

{{REQUIRED_CHANGES}}

{{PRIOR_ANALYSIS}}

Read the repository with your tools as much as the plan needs. If checked-out behavior already satisfies the request, do not invent adjacent improvements: return disposition already_satisfied with the evidence, and a question asking which branch, deployment, or entry point still fails. If ambiguity prevents a bounded plan, return disposition needs_clarification with one specific question. Otherwise return disposition plan.

Rules for a plan:
- Every task cites at least one requirement by capability and exact name, and at least one scenario by exact name, and every scenario it cites must belong to a requirement it cites.
- Every added or modified requirement has at least one scenario. Requirements use SHALL or MUST, and scenarios give a WHEN and a THEN.
- Task ids look like 1.1, and tasks that share the number before the dot share one group.
- Prefer one task per cohesive set of files. Split only when parallel work or independent verification is real: chained tasks that write the same files are merged by code, and each task costs a builder session and a review.
- Verification commands are single commands with no shell operators, and the executable must be one of bun, node, npm, npx, git or openspec.
- Read and write scopes are repository-relative paths or globs that stay inside the repository.

Return exactly one JSON object and nothing else, with no markdown fence, matching this JSON Schema:
{{PLAN_SCHEMA}}

{{VALIDATION_FAILURES}}
