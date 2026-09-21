## 1. CLI

- [ ] 1.1 Rename the flag in the parser and its help text

  ```yaml harness-task
  id: "1.1"
  dependsOn: []
  role: builder
  reads: ["src/**"]
  writes: ["src/cli.ts","tests/cli.test.ts"]
  requirements: ["cli: The debug flag is accepted"]
  scenarios: ["Debug flag enables debug output"]
  verify: ["bun test tests/cli.test.ts"]
  manual: null
  ```