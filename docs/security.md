# Security Model

Muster is a correctness-ready beta. Standard agent tools run directly on the host. Profiled host commands are brokered and audited; these controls do not provide operating-system process or network isolation.

## Trust boundary

Child agents default to the original fusion-harness tool sets: `read`, `grep`, `find`, and `ls` for read-only tasks; writers also get `bash`, `edit`, and `write`; validators get the read tools plus `write`. Global and per-slot child extension/tool configuration is honored. These standard tools execute directly in the child. Declared task paths are included in the prompt, but the broker does not enforce those paths for standard tools. Writer leases still serialize writing tasks.

The parent controller retains lifecycle and evidence checks. `muster_submit_scope` and `muster_submit_gate` submit structured evidence through the broker. Internal callers can explicitly select `toolMode: "brokered"` to use the restricted filesystem/command replacements.

The optional brokered command path enforces:

- authenticated broker requests and role-specific tool allowlists;
- canonical worktree and declared path checks;
- an active writer lease for source mutation;
- executable allowlists, argument-array spawning, and an explicit working directory;
- a minimal environment allowlist that excludes credentials by default;
- timeout, output, cancellation, and process-cleanup limits;
- preflight checks for authentication, elevated permissions, destructive operations, and external side effects; and
- repository snapshots and a post-command diff audit before results can become accepted task evidence.

The implementation contracts are defined in [command-profile.ts](../src/tools/command-profile.ts) and [host-runner.ts](../src/tools/host-runner.ts).

## Residual risk

Approved commands execute on the host with the permissions of the current operating-system user. A process can access files outside the repository or communicate over the network when the host account and host configuration permit it. Environment minimization does not prevent a process from discovering credentials stored elsewhere on the host.

For commands routed through the audited host runner, repository diff auditing detects unauthorized repository changes after a command runs and rejects its evidence. Standard child `bash`, `edit`, and `write` operations do not receive that per-command audit. Auditing cannot undo non-repository filesystem changes, network requests, or other host side effects.

Controller-managed tasks classified as requiring authentication, elevated permission, destructive action, or an external side effect stop at a persisted manual checkpoint before execution. This controller check does not intercept arbitrary commands issued through the standard child `bash` tool.

## Future isolation

OCI or native process and network isolation is deferred to a non-blocking post-beta hardening milestone. The work remains behind the command-runner interface so role, broker, task, and evidence contracts do not need to change. See the [post-beta roadmap](roadmap.md).
