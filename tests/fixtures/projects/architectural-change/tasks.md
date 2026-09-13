## 1. Implementation

- [ ] 1.1 Establish the architectural boundary

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/**"]
  writes: ["src/auth.ts", "src/persistence.ts"]
  requirements: ["architecture: Security boundary"]
  scenarios: ["Architectural boundary is enforced"]
  verify: ["bun test tests/security.test.ts"]
  manual: null
  ```

- [ ] 1.2 Integrate the boundary

  ```yaml harness-task
  id: "1.2"
  dependsOn: ["1.1"]
  role: builder
  reads: ["src/**"]
  writes: ["src/api.ts", "src/service.ts"]
  requirements: ["architecture: Integrated behavior"]
  scenarios: ["API uses the approved boundary"]
  verify: ["bun test tests/integration.test.ts"]
  manual: null
  ```