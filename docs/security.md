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

## Judgment egress

The judgment layer answers narrow typed questions about a state through a hosted classifier from a third party ([TypeSafe](https://docs.typesafe.ai/api)). When it is enabled, **repository content leaves the machine** and is sent to that service. This is third-party egress, and it is separate from the model providers that Muster's agents use.

Judgment is off unless it is opted into. Both of these must be set, and with either absent nothing is sent and the harness behaves exactly as it does without judgment:

| Variable | Meaning |
| --- | --- |
| `MUSTER_JEV=1` | Enables judgment. Without it, decisions report that judgment is disabled. |
| `MUSTER_JEV_API_KEY` | The service credential. With the flag set but no key, decisions report that judgment is not configured. |
| `MUSTER_JEV_MODE` | `shadow` (the default) evaluates and records a decision but never lets it change behavior; `enforce` lets a decision act. Any other value makes judgment unavailable rather than guessing. |

A decision may also require its own enabling variable in addition to these; the call-site table below names it.

What the layer does before anything is sent:

- **Redaction is best-effort, not a guarantee.** Every string in a state is scrubbed of bearer credentials, credential-bearing command flags, `key: value` secrets, private key blocks, and secret-bearing URL query parameters, and the API key is scrubbed by value. Patterns cannot recognize every secret, so a secret in an unusual form can still be sent. Treat redaction as a second line of defense, not permission to send sensitive content.
- **Credential-bearing files are refused, not redacted.** Each call site declares the repository paths that contribute to its state. A request is refused, and nothing is sent, if any declared path is an environment file (`.env`, `.env.*`, `*.env`), a private key or certificate file (`*.pem`, `*.key`, `*.crt`, `*.p12`, SSH identity files, and similar), a package-registry authentication file (`.npmrc`, `.yarnrc`, `.pypirc`, `.netrc`, and similar), or a cloud or version-control credential file (`.aws/credentials`, `.git-credentials`, `.kube/config`, and similar). The layer can only check the paths a call site declares, so a call site that omits a path defeats this check.
- **The process environment is never included.** The layer accepts no environment from callers, so no environment variable can reach a state.
- **Size is bounded and states are never truncated.** A state plus its longest question above 32,000 tokens, or a state plus all questions above 64,000 tokens, is refused. Token counts are deliberately over-estimated. Callers excerpt; the layer does not cut content down to fit.
- **Requests use a pinned model version**, and a response from any other version is discarded.

Every decision is recorded in the change's run store with a digest of the redacted state, not the state itself. The API key is never written to a record, usage entry, or test fixture.

### Provider data handling

Read the provider's own terms before enabling judgment on proprietary code: the [privacy policy](https://typesafe.ai/legal/privacy-policy), the [data processing addendum](https://typesafe.ai/legal/data-processing), and the [master customer agreement](https://typesafe.ai/legal/mca). As published when this section was written, the addendum limits the provider's use of customer personal data to documented instructions and bars selling or sharing it, retention is described as "as long as necessary" for the purpose rather than as zero retention, and the customer agreement grants the provider a broad licence to process the data and queries a customer submits. Muster does not verify any of this. **Operators handling proprietary code should confirm their retention and licensing arrangement with the provider before enabling judgment.**

### Egress by call site

Each call site that is enabled sends a state, and this table names it. A change that adds a call site adds its row in the same change; a call site with no row here must not ship. Each call site sends nothing unless judgment is enabled as described above.

| Decision | Enabling variable | State sent | Declared source paths |
| --- | --- | --- | --- |
| `planning.complexity` (complexity classification) | None beyond `MUSTER_JEV` and `MUSTER_JEV_API_KEY` | The effective request text (on refinement this includes the previous review's required changes), the planning phase, and the preflight evidence paths and reasons. | The preflight evidence paths. |
| `planning.preflight` (planning preflight) | None beyond `MUSTER_JEV` and `MUSTER_JEV_API_KEY` | The effective request text (on refinement this includes the previous review's required changes) and up to ten candidate source files retrieved by code from the request's identifiers, each with its repository path and an excerpt of at most 600 bytes. **This is the largest planning egress: it sends repository source excerpts.** Files the credential denylist names, ignored files, binary files, files over 2 MiB, and dependency directories are never candidates. | The paths of every candidate. |
| `context.capsule_ranking` (context capsule ranking) | None beyond `MUSTER_JEV` and `MUSTER_JEV_API_KEY` | The task contract (definition, requirements, scenarios, decisions, read and write scopes, and acceptance) and up to thirty relevant context slices, each with an excerpt of at most 600 bytes. **Slice excerpts can include source, specification text, and dependency reports.** A slice is identified for the credential denylist only when it is file-backed and carries its repository path; a slice without a path is protected by secret redaction alone, so whatever builds slices must set the path whenever a slice comes from a file. Capsule assembly is not yet connected to task execution, so this call site sends nothing until that wiring exists. | The repository path of every scored slice that has one. |

## Future isolation

OCI or native process and network isolation is deferred to a non-blocking post-beta hardening milestone. The work remains behind the command-runner interface so role, broker, task, and evidence contracts do not need to change. See the [post-beta roadmap](roadmap.md).
