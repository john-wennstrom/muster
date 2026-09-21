---
variables: [ID, DESCRIPTION, ID_JSON, DEPENDS_ON, ROLE, READS, WRITES, REQUIREMENTS, SCENARIOS, VERIFY, MANUAL]
---
- [ ] {{ID}} {{DESCRIPTION}}

  ```yaml harness-task
  id: {{ID_JSON}}
  dependsOn: {{DEPENDS_ON}}
  role: {{ROLE}}
  reads: {{READS}}
  writes: {{WRITES}}
  requirements: {{REQUIREMENTS}}
  scenarios: {{SCENARIOS}}
  verify: {{VERIFY}}
  manual: {{MANUAL}}
  ```
