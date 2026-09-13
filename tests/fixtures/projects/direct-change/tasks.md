## 1. Implementation

- [ ] 1.1 Implement the localized change

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/feature.ts"]
  writes: ["src/feature.ts"]
  requirements: ["feature: Localized behavior"]
  scenarios: ["Direct change succeeds"]
  verify: ["bun test tests/feature.test.ts"]
  manual: null
  ```