Implement OpenSpec change {{CHANGE}}, phase {{PHASE}} — {{PHASE_TITLE}}.

The phase boundary is hard. Do not create dependencies on tasks outside this phase, and do not execute work from another phase.

Create one delegation plan as a single raw JSON object with this exact shape:
{"tasks":[{"id":"{{TASK_ID_EXAMPLE}}","assignee":"{{ASSIGNEE_EXAMPLE}}","description":"...","depends_on":[],"outputs":[],"mode":"write","reads":["src/**","tests/**"],"writes":["src/owned/**","tests/owned.test.ts"]}]}

Use only these task ids, and assign every task exactly once:
{{TASKS}}

Use only these assignee ids:
{{ASSIGNEES}}

Plan the smallest useful task breakdown. Dependencies may connect tasks within this phase only. All tasks must use mode "write" unless a task can be completed entirely read-only. Every task declares repository-relative reads and writes scopes; read tasks use writes:[], and write tasks enumerate every path they may mutate without repository-wide wildcards.

AUTHORITATIVE CONTEXT:
{{CONTEXT}}
