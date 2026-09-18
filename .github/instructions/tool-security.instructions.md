---
description: "Use when working on src/tools/**, host command brokering, executable allowlists, writer leases, or anything touching how child agents run commands/edit files."
applyTo: "src/tools/**,src/agents/child-runner.ts,src/agents/child-broker.ts,src/execution/**"
---

# Tool/command security model

Full detail: `docs/security.md`. Key points to keep true when editing this area:

- Standard child tools (`read`, `grep`, `find`, `ls`, and for writers/validators `bash`, `edit`, `write`) run **directly on the host** — they are not routed through the broker's per-operation path/command checks. Do not assume standard `bash`/`edit`/`write` calls get audited; only the brokered command path (`src/tools/command-profile.ts`, `src/tools/host-runner.ts`) does.
- The brokered path must keep enforcing: authenticated broker requests + role tool allowlists, canonical worktree/declared-path checks, an active writer lease for source mutation, executable allowlists with argument-array spawning (never shell-string spawning) and explicit cwd, a minimal env allowlist that excludes credentials by default, timeout/output/cancellation/process-cleanup limits, and pre/post repo-diff auditing.
- Writer leases must still serialize writing tasks even for standard (non-brokered) tool calls.
- Tasks classified as needing auth, elevated permission, a destructive action, or an external side effect must stop at a persisted `AWAITING_USER` checkpoint rather than executing — this classification does not intercept the standard child `bash` tool, so don't rely on it as a safety net for arbitrary shell commands.
- Full OS-level process/network isolation is explicitly out of scope for beta (deferred, see `docs/roadmap.md`) — don't claim isolation guarantees this code doesn't provide.
