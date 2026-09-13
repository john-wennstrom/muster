# muster

Muster is a correctness-ready beta for OpenSpec-driven multi-agent development workflows in Pi. The preferred workflow surface is `/change`.

## Security boundary

Beta host commands are brokered and audited, but these controls do not provide operating-system process or network isolation. Approved commands run as the current operating-system user and can reach resources available to that account. See the [security model](docs/security.md) for the enforced controls and residual risks.

OCI or native process and network isolation is a non-blocking post-beta hardening item behind the command-runner interface. It is tracked in the [roadmap](docs/roadmap.md) and is not a beta capability.

Validate documentation links, command examples, and security wording with:

```text
bun run docs:check
```

The complete local and cross-platform checks are in the [testing guide](docs/testing.md).

## Legacy command migration

The compatibility commands remain available during the beta and display migration guidance when invoked. When controller state is configured, they use the same lifecycle prerequisite checks as their preferred equivalents before starting work.

| Compatibility command | Preferred command |
| --- | --- |
| `/refine <change>` | `/change refine <change>` |
| `/implement <change> [next\|phase]` | `/change implement <change>` |
| `/ship <change>` | `/change finish <change>` |

Low-level `/fh-*` diagnostics and orchestration commands remain available; use `/change status <change>` to inspect the controller-derived lifecycle before migrating a workflow.