## Context

See `proposal.md` for motivation. The rule classifier is a synchronous pure function of a structured command request: it lower-cases the executable, strips a Windows suffix, and matches privilege escalation, credential login, forced or destructive version-control operations, and publishing. The brokered runner calls it first and denies a match with a prohibited-command error and an audit event. It then applies the version-control subcommand allowlist, then validates the request against the command profile, then snapshots the repository, runs the command with bounded output and timeout, snapshots again, and audits the diff against the task's write scopes.

Only one production path reaches the brokered runner: the legacy task broker used by brokered child agents. A second consumer, the controller's runtime manual-action guard, uses the same classifier to create a persisted manual checkpoint, but has no production caller yet.

The command profiles restrict executables to the package managers, the runtime, version control, and the OpenSpec tool, and the runner refuses shell executables. So most examples of dangerous programs are already refused by the profile. What remains are commands whose danger is in an argument — a package script name, an `npx` target, a runtime script path.

The judgment layer supplies typed decisions, shadow and enforce modes, audit records, and a fallback for every unavailable reason.

## Goals / Non-Goals

**Goals:**

- Add manual categories the rules cannot see, with no way to remove or relax anything.
- Keep the rule classifier, the version-control allowlist, and the profile checks byte-for-byte as they are.
- Add negligible latency and no new failure mode: an unavailable judgment proceeds as today.

**Non-Goals:**

- Reading package script bodies or any file content. Judgment sees the command line only.
- Judging arbitrary shell, which the runner refuses in any case.
- Changing what a denial or a checkpoint does. Judged categories reuse the existing handling.
- Changing the standard child tools, which the security documentation already describes as not intercepted.

## Decisions

### 1. An asynchronous classifier beside the pure one

The pure rule classifier stays untouched. A new module in the tools layer wraps it: it runs the rules first, and only when they return nothing does it consult judgment, returning the category and its source, rule or judgment. Both enforcement points call the wrapper, so the rules-first ordering and the tagging live in one place.

Alternative considered: make the rule classifier itself asynchronous. Rejected because it would change a pure, exhaustively tested function into a networked one and would put the floor and the addition in the same code path.

### 2. Judge only commands that would otherwise run

In the brokered runner the order is: rules, then the version-control allowlist, then profile validation, then judgment, then the repository snapshot and spawn. Placing judgment after profile validation means a command that the runner would refuse anyway never generates egress or latency, and the floor demonstrably runs before anything model-derived.

### 3. The category drives the decision; the yes/no answers are recorded

The decision asks a category question with five options — none, authentication, elevated permission, destructive, and external side effect — each defined in terms of reversibility and reach, plus three yes/no questions on irreversibility, remote mutation, and credential use. The gate acts on the category alone: any category other than none adds that category, at any confidence, and none proceeds. The yes/no answers are recorded so the calibration data can show where the category and the yes/no answers disagree. Using them to add categories as well would raise sensitivity, and therefore the number of spurious stops, before any data exists.

### 4. Deny where the runner denies, checkpoint where the controller checkpoints

A judged category in the brokered runner throws the same prohibited-command error as a rule category, carrying the category, the source, and the confidence, and emits the same audit event. In the controller guard it creates the same checkpoint. Reusing the handling keeps the meaning of a stop identical regardless of its source and adds no new outcome for consumers to learn.

### 5. Skip what is already restricted

Commands under the read-only profile, and version-control commands whose subcommand is on the read-only allowlist, are not judged. They cannot mutate anything, so judgment could only add latency.

### 6. Latency is bounded twice

Each judgment has a deadline of at most 1.5 seconds, after which the command proceeds as today. And a small bounded cache keyed by the canonical form of the profile, the lower-cased executable, the arguments, and the relative working directory reuses a classification within a run, so a repeated test command sends one request. Only successful classifications are cached; an unavailable result is retried on the next command. The cache lives in the runtime, so it dies with the run and never crosses a pinned-model or decision-version change.

### 7. Only the command shape leaves the machine

The state is the executable, the arguments, the working directory relative to the worktree, and the profile. Arguments are redacted by the layer. No file is read, no environment is included, and no path is declared for the denylist because no file content contributes. Package script bodies are not resolved, which limits accuracy for wrapped commands but keeps the state to a fixed, small, documentable shape.

### 8. The runtime is threaded through the existing option chain

The implementation phase already builds the task step context, which builds the builder step's options, which build the legacy broker's options, which call the runner. The optional runtime is added to each in turn. Absent at any point, judgment is simply not consulted, so partial wiring degrades safely and tests can inject a runtime at the layer they exercise.

### 9. Shadow and effects

The decision adds caution only. In shadow mode every command proceeds as today and the record holds the category and confidence; the layer's summary reports by category how many commands would have been stopped, which is the review queue for calibration.

## Risks / Trade-offs

- **Spurious stops annoy users and stall agents** → Only a non-none category stops a command, shadow mode measures the rate before enforce, the cache avoids repeated judgments, and a stop surfaces as an ordinary denial with a stated category and source.
- **Manipulated arguments steer judgment to none** → The worst case is today's behavior, since rules and profile run first and judgment can only add.
- **Judgment sees only the command line** → A wrapped script is judged by its name. Documented; resolving script bodies is a separate, egress-widening decision.
- **Added latency on a hot path** → A short deadline, a cache, and skipping read-only commands.
- **Plumbing across several layers** → Optional at every hop and tested at the adapter.
- **A judged category may disagree with a user's intent for a script they wrote** → The category is stated in the denial, and the manual-checkpoint path lets a human confirm.

## Migration Plan

1. Register the decision and add the asynchronous classifier with property tests for the floor.
2. Add judgment to the brokered runner and to the controller guard.
3. Thread the runtime through the phase, step context, builder step, and legacy adapter.
4. Add a new adversarial test file that re-runs the existing adversarial scenarios under three judgment doubles, leaving the existing adversarial file untouched.
5. Add the documentation row and description, then run the full validation set, including the host-runner job.

Rollout: shadow first, review what would have been stopped, tune the decision's wording if the rate is high, then enforce. Rollback: unset the enabling flag, or revert, which restores the rule-only path.

## Open Questions

- Whether package script bodies should be resolved and included for wrapped commands. It would improve accuracy and widen egress, so it warrants its own change and its own documentation.
