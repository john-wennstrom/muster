## 1. Toolbar

- [ ] 1.1 Add the filter to the toolbar view

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/**"]
  writes: ["src/toolbar.ts","tests/toolbar.test.ts"]
  requirements: ["toolbar-search: The toolbar filters items"]
  scenarios: ["Typing filters the list","Clearing the box restores the list"]
  verify: ["bun test tests/toolbar.test.ts"]
  manual: null
  ```

- [ ] 1.2 Document the search box

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["docs/**"]
  writes: ["docs/toolbar.md"]
  requirements: ["toolbar-search: The toolbar filters items"]
  scenarios: ["Typing filters the list"]
  verify: ["bun run docs:check"]
  manual: null
  ```