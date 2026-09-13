## 1. Implementation

- [ ] 1.1 Implement the bounded service change

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/api.ts", "src/service.ts"]
  writes: ["src/service.ts"]
  requirements: ["service: Bounded behavior"]
  scenarios: ["Bounded service succeeds"]
  verify: ["bun test tests/service.test.ts"]
  manual: null
  ```

- [ ] 1.2 Update the public API

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/api.ts", "src/service.ts"]
  writes: ["src/api.ts", "tests/api.test.ts"]
  requirements: ["api: Public behavior"]
  scenarios: ["Public API delegates to the service"]
  verify: ["bun test tests/api.test.ts"]
  manual: null
  ```