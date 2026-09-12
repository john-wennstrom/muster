## Why

The current Fusion Harness contains useful multi-model execution primitives, but its workflow, persistence, safety boundaries, and OpenSpec integration do not yet form one recoverable development system with OpenSpec as the sole durable contract. This change imports that baseline into muster and evolves it into one Pi extension that can plan, execute, review, and verify OpenSpec changes while failing closed at quality, permission, and human-interaction boundaries.

## What Changes

- Import the Fusion Harness source snapshot at commit `51f1d85499a1292cb79036d6ae237db7ea52096e` into muster without Git history or source-file attribution headers, while retaining its required MIT notice in `THIRD_PARTY_NOTICES.md`.
- Establish a Node.js 22, Bun, TypeScript, ESM project baseline that ships one repository and one Pi extension on Linux, macOS, and native Windows.
- Make OpenSpec the only durable source for proposals, requirements, designs, implementation tasks, planning review, verification evidence, and archived change history.
- Add a capability-detected, typed OpenSpec CLI adapter that fails closed on unavailable commands, malformed JSON, incompatible payloads, stale artifacts, and validation failures.
- Add a canonical `/change` command family for explore, propose, refine, review, implement, verify, finish, status, and resume workflows.
- Preserve existing `/fh-*`, `/refine`, `/implement`, and `/ship` commands during a documented deprecation period, routing overlapping behavior through the new controller where practical.
- Compile structured OpenSpec task metadata into a recoverable dependency DAG with task-scoped context, fresh builder sessions, focused tests, independent review, and one global source-writer lease per worktree.
- Replace Fusion's current no-worktree rule with controller-owned dedicated change worktrees by default; child agents may not create or manage worktrees.
- Enforce role tool and filesystem permissions outside prompts through brokered tool allowlists, canonical path checks, writer leasing, prohibited-operation interception, constrained host command execution, and post-command diff auditing. Defer operating-system process isolation and OCI sandboxing to a post-beta hardening milestone.
- Add persisted `awaiting_user` checkpoints. An affected DAG branch stops and Pi notifies the user when a task requires secrets/authentication, elevated privileges, destructive action, external side effects, or resolution of a material design conflict. Resume requires an explicit user confirmation and never captures secrets through an agent prompt.
- Reduce pre-implementation review verdicts to `APPROVE` and `REVISE`; implementation requires a current `APPROVE` digest.
- Add fresh-context verification that records durable evidence but does not automatically commit or archive. `/change finish` remains an explicit subsequent action.
- Keep model providers behind Pi/Fusion interfaces. The beta inherits existing Pi-supported providers and requires OpenAI support; a VS Code execution adapter for GitHub Copilot is a deferred post-beta capability because Pi cannot currently spawn Copilot models.
- Add optional, capability-detected Serena and Hindsight adapters that never override OpenSpec or repository state.
- Add run persistence, interruption recovery, usage accounting, and optimization telemetry. The first release is a correctness-ready beta; the proposed 25-50% token reduction remains a measured hypothesis rather than a release claim.

## Capabilities

### New Capabilities

- `project-foundation`: Imported source baseline, cross-platform runtime, packaging, compatibility, and migration constraints for one muster Pi extension.
- `openspec-contract`: Typed OpenSpec capability handshake, artifact ownership, schema support, validation, and archive delegation.
- `change-workflows`: User-facing `/change` lifecycle, work classification, prerequisite resolution, and legacy command migration.
- `agent-runtime`: Fresh role sessions, provider routing, task capsules, context budgets, and optional integration adapters.
- `task-orchestration`: Structured task metadata, dependency DAG scheduling, worktree ownership, writer exclusivity, and design-conflict handling.
- `review-and-verification`: Independent planning review, artifact freshness, task review, final verification, evidence, and finish gating.
- `manual-interaction`: Persisted manual-action checkpoints, Pi notification, branch pausing, safe instructions, and explicit resume behavior.
- `policy-enforcement`: Brokered tool/path permissions, TDD, systematic debugging, protected correctness gates, prohibited-operation interception, and explicit beta isolation limits.
- `runtime-recovery`: Run manifests, atomic state transitions, interruption recovery, idempotency, and runtime artifact retention.
- `telemetry-and-cost`: Per-invocation usage ledger, budget enforcement, run summaries, and evidence-based optimization reporting.

### Modified Capabilities

None. The repository has no current capability specifications.

## Impact

- **Repository:** muster becomes the canonical implementation repository; the sibling Fusion repository remains an import source, not a runtime dependency.
- **Code:** Fusion extension modules, commands, prompts, and tests are imported and incrementally reorganized behind controller, OpenSpec, execution, review, persistence, policy, context, and telemetry boundaries.
- **Interfaces:** `/change` becomes the preferred command surface. Existing commands remain temporarily available with deprecation guidance.
- **Dependencies:** Node.js 22, Bun, Git, Pi, and an external OpenSpec CLI are required. OCI runtimes are not required for beta. Serena and Hindsight are optional.
- **Provider compatibility:** Existing Pi providers remain available; OpenAI is required for beta acceptance. GitHub Copilot execution is deferred behind a future VS Code adapter.
- **Security and operations:** Agents cannot request secrets through model-visible prompts, elevate privileges, perform destructive operations, or cause external side effects without entering a persisted manual checkpoint. Beta host commands are brokered and audited but are not OS-sandboxed, which remains a documented residual risk. Successful verification leaves the branch and worktree intact and does not commit or archive automatically.
- **Release status:** The initial release is a correctness-ready beta across Linux, macOS, and native Windows, with optimization telemetry enabled and no unsubstantiated token-reduction claim.