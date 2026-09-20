## Why

Before a brokered host command runs, a fixed rule set decides whether it needs manual approval: privilege escalation, credential login, forced or destructive version-control operations, and publishing. Everything else falls through to the version-control subcommand allowlist and the command profile's executable allowlist.

The rule set reads only the shape of the command line, so it cannot see what a command does when the command line hides it. The profiles already restrict executables to a small set — the package managers, the runtime, version control, and the OpenSpec tool — which means many dangerous programs are refused outright. The gap is what those allowed executables can be made to do: a package script named `deploy` or `release`, an `npx` invocation of an arbitrary package, a runtime invocation of an arbitrary file. None of those trips a rule, and each can publish, deploy, delete, or post to a remote.

A typed judgment can read a command line the way a reviewer would and say whether it looks like an authentication step, a privilege escalation, a destructive operation, or an effect outside the machine. Because it can only add a manual category to a command the rules would allow, it widens the net without weakening the floor. This is one place where the cost argument is secondary: it is a safety improvement that happens to be nearly free.

## What Changes

- Keep the existing rules, the version-control allowlist, and the profile checks exactly as they are, running first. Any command they deny is denied exactly as before and is never sent for judgment.
- For a command that would otherwise run, ask a typed judgment which manual-approval category, if any, it belongs to. A category other than none is handled as a rule-produced category is handled in that path: denied in the brokered runner, and a persisted manual checkpoint in the controller path.
- Treat an uncertain category the same as a confident one, because an uncertain classifier on a destructive-operation question is itself a reason to involve a human. A judged none, an unavailable judgment, and a disabled judgment all proceed exactly as today.
- Skip judgment for commands under the read-only profile and for version-control commands already restricted to read-only subcommands.
- Bound the added latency with a short per-command deadline and by reusing the classification of an identical command within a run.
- Send only the shape of the command — executable, redacted arguments, working directory relative to the worktree, and profile — never the environment or any file content.
- Run in shadow mode first, recording what would have been stopped without stopping anything.

## Capabilities

### New Capabilities

- `judgment-command-classification`: How brokered host commands are checked for manual-approval categories — the existing rules remain an unchanged floor, and typed judgment can only add a category for commands the rules would otherwise allow.

### Modified Capabilities

None.

## Impact

- **Brokered command path:** one judgment call for each judged command, after the rules and profile checks and before the command starts. The command's execution, audit, output limits, and evidence rules are unchanged.
- **Checkpoint path:** the controller's runtime manual-action guard accepts the same classification.
- **Wiring:** the judgment runtime reaches the brokered runner through the implementation phase, the task step context, the builder step, and the legacy child adapter.
- **Cost:** about $0.00002 per judged command.
- **Egress:** executable, redacted arguments, relative working directory, and profile. Documented in the security documentation, which also describes the added category source.
- **Limitation:** judgment sees the command line, not the body of a package script, so a script name is judged by name. Resolving script bodies would improve accuracy and would send more content, so it is deferred.
- **Rollout gate:** zero regressions in the existing adversarial broker and host-runner tests, and shadow mode's record of what would have been stopped reviewed before enforce is used.
- **Ordering:** depends on `judgment-layer`. Independently revertable.
