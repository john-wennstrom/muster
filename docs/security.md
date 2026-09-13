# Security Model

Muster is a correctness-ready beta. Beta host commands are brokered and audited, but these controls do not provide operating-system process or network isolation.

## Trust boundary

The parent controller, broker, and host command runner are trusted enforcement components. Child agents request structured operations through the broker instead of receiving a generic shell or unrestricted mutation tools.

The command path enforces:

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

Repository diff auditing detects unauthorized repository changes after a command runs and rejects its evidence. It cannot undo non-repository filesystem changes, network requests, or other host side effects. Run Muster only in repositories and on machines where that remaining access is acceptable.

Commands classified as requiring authentication, elevated permission, destructive action, or an external side effect stop at a persisted manual checkpoint before execution. Never enter credentials into an agent-visible prompt; complete authentication directly through the relevant trusted tool or terminal.

## Future isolation

OCI or native process and network isolation is deferred to a non-blocking post-beta hardening milestone. The work remains behind the command-runner interface so role, broker, task, and evidence contracts do not need to change. See the [post-beta roadmap](roadmap.md).