# Roadmap

## Post-beta process and network isolation

Status: non-blocking post-beta hardening backlog. This work is not required for beta acceptance and does not weaken or replace the beta broker, command policy, manual-checkpoint, or audit controls described in the [security model](security.md).

All isolation work stays behind the command-runner interface, preserving the existing structured request, result, cancellation, audit, and evidence contracts. Planned investigation and delivery items are:

- define capability negotiation for isolated command-runner implementations;
- prototype an OCI-backed runner where a supported OCI runtime is available;
- evaluate native process and network containment adapters for Linux, macOS, and Windows;
- define filesystem mounts, network-deny defaults, resource limits, signal handling, and cleanup behavior;
- add cross-platform conformance and adversarial tests shared by host and isolated runners; and
- document migration, opt-in or default policy, diagnostics, and fallback behavior before enabling an isolated runner.

The current host runner remains the beta implementation. Future adapters must fail closed when requested isolation is unavailable and must not require changes to role, broker, task, or evidence contracts.