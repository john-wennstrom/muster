# Roadmap

## Design-to-implementation audit

Originally audited 2026-09-17 against the [OpenSpec-Driven Multi-Agent Development Harness](../openspec-driven-multi-agent-harness-design.md) design, and revised on 2026-09-21 after the simplification series (`simplify-01` to `simplify-07`) retired the legacy extension and finished the single pipeline. Completed items are removed; what remains is the gap inventory that was not closed. Items carried over from the original audit were not all re-verified in the revision, so treat an open item as a lead to check, not as a confirmed defect.

### Current command availability

Every `/change` action has a production handler, assembled in [the production dependency factory](../src/change/dependencies.ts): `explore`, `propose`, `refine`, `review`, `implement`, `resume`, `verify`, `finish` and `status`. [Muster registration](../src/muster/index.ts) registers only `/change` and the flags the pipeline reads; the retired commands are not aliased. How the pipeline works today is described in the [README](../README.md) and drawn in the [command flow](command-flow.md).

### How to use this audit

This is a gap inventory, not a second executable task plan. Promote selected items into OpenSpec changes with requirements, scenarios, and structured tasks before implementation. Do not maintain a competing permanent plan here. The existing [implementation checklist](../openspec/changes/build-openspec-multi-agent-harness/tasks.md) contains many checked library tasks, including command tasks; those checks are not proof of working production workflows.

Labels used below:

- **Unwired:** relevant controller/library behavior exists, but the default extension does not assemble it.
- **Partial:** production behavior exists but does not satisfy the complete target.
- **Gap:** behavior is missing from the inspected controlling path or conflicts with the target.
- **Acceptance risk:** a concrete integration interaction needs a discriminating real-file/process test before calling it complete.
- **Decision:** the later OpenSpec design intentionally differs from the original proposal, or the contracts need reconciliation.

Priority: **P0** makes the primary command surface usable and trustworthy; **P1** completes the engineering and recovery contract; **P2** delivers optional integrations and measured optimization. P0 does not permit bypassing P1 correctness gates: those gates must work before production source-writing commands are accepted.

### P0.2 Visible agent execution and results

Target: design sections 6, 22, 24 and 38, plus the requested Fusion-style multi-column experience. The original design requires observability but does not explicitly mandate columns; visual parity is an additional user requirement.

Evidence: [agent columns](../src/change/ui/agent-columns.ts), [agent progress](../src/change/agent-progress.ts), [child spawn](../src/agents/spawn.ts), [production explore](../src/change/phases/exploration.ts). `/change` exposes only `notify` and `sendMessage`, and explore returns only model/content after awaiting the child.

- [ ] **Gap:** connect child start, tool activity, response deltas, usage, exit, error, and cancellation to the presenter. Expose the active `AgentRun` or equivalent typed events while work is happening, not only after it completes.
- [ ] **Gap:** show a full-width agent panel for explore and other single-agent stages; responsive columns for simultaneous opinions/readers; a full-width synthesis/review stage where appropriate. Panels must represent agents actually dispatched, not imply simultaneous source writers.
- [ ] **Gap:** display change, phase, task, role, model, elapsed time, current operation, tokens, and known/unknown cost. Show an immediate starting state and useful progress during slow child startup or OpenSpec calls.
- [ ] **Unwired:** connect the scheduler to a taskboard showing pending, dependency-blocked, running, reviewing, debugging, awaiting-user, completed, failed, and cancelled states, including the current writer/worktree.
- [ ] **Partial:** post status, planning outcomes, review findings, verification evidence, errors, and checkpoint instructions to persistent transcript output. Explore already does this; status and manual UI still rely on transient notifications. Use notifications for short alerts only.
- [ ] **Gap:** carry per-command cancellation through OpenSpec, scheduling, child processes, and host commands. Connect Escape and session shutdown; clean up subscriptions, tickers, children, and leases in `finally`; retain a stopped-run summary and partial evidence.
- [ ] **Gap:** share ownership of active-run displays and lifecycle-changing commands so concurrent `/change` commands cannot overwrite widgets or race state.
- [ ] **Acceptance risk:** test wide and narrow terminals, resizing, long output, missing TUI APIs/headless operation, startup failure, cancellation, restart, and repeated commands. Verify persistent output remains visible after temporary widgets disappear. Keep display-only telemetry out of model context where supported and redact secrets before rendering/persistence.

Acceptance: `/change explore` visibly starts, streams activity, can be stopped, and retains a final result. Multi-agent stages show the agent columns; no command appears to hang silently.

### P0.3 Real OpenSpec state and freshness

Target: design sections 7-11, 17, 26-29, 32 and 35. Evidence: [snapshot loader](../src/change/snapshot.ts), [snapshot derivation](../src/controller/change-snapshot.ts), [Git diff](../src/execution/git.ts), [source digests](../src/execution/change-digests.ts), [artifact digest](../src/review/artifact-digest.ts), [schema](../schemas/fusion-driven/schema.yaml), [final validator](../src/review/validator.ts).

- [ ] **Partial:** collect OpenSpec status first and honor `changeRoot`, `artifactPaths`, planning home, and instruction-resolved paths. The current loader assumes `cwd/openspec/changes/<name>` and returns null without tasks, so a valid proposal-only change cannot be represented as planning.
- [ ] **Gap:** preserve explicit adapter errors for missing executable, incompatible JSON, missing artifacts, and I/O failures. The collector currently catches every status error as `planningComplete = false` and every discovery/hash error as a sentinel digest, hiding the cause.
- [ ] **Gap:** fail closed when a manifest references missing checkpoint evidence. The production loader currently ignores `ENOENT` for those checkpoints, unlike the recovery planner. Validate identities and record shapes before using state.
- [ ] **Gap:** include staged changes and relevant untracked file contents in source freshness. `GitAdapter.diff()` is unstaged-only; `computeSourceDigest()` hashes HEAD plus that diff. A staged change or edited untracked file can therefore evade source invalidation. Hash relevant content, not only status letters and filenames; test binary files, deletions, renames, and staged/unstaged combinations.
- [ ] **Decision / acceptance risk:** distinguish material planning edits from evidence-authorized task checkbox updates. Hashing raw task bytes makes each completion invalidate planning approval and recovery state. Define a reviewed plan projection or explicit evidence-bound progress transition; do not simply accept arbitrary task edits or re-stamp approval without review.
- [ ] **Acceptance risk:** remove circular readiness requirements. Final validation currently requires `status.isComplete` and every artifact to be `done`, while the schema includes the verification artifact that `verifyChange()` writes only after validation. Test first-time verification against the real CLI, then make phase prerequisites explicit. Also verify pre-review planning completeness can reach `REVIEW_REQUIRED` without already having review/verification.
- [ ] **Partial:** bind observations to the actual execution worktree, not the current planning checkout. A stored worktree manifest currently conflicts with a snapshot collected from another checkout. Recheck authoritative inputs immediately before writer dispatch, completion acceptance, verification acceptance, and archive.
- [ ] **Gap:** implement observable `FINISHING`/`COMPLETE` and archive-aware status. These names exist in transition rules, but snapshot derivation never returns them and the loader loses the active change when its tasks move to the archive.
- [ ] **Acceptance risk:** prevent verification from making its own source digest stale through writing verification/runtime output. Define relevant source exclusions and test a real verify-then-finish sequence without manually patching digests.

Acceptance: real files move through planning, review, task progress, verification, and archive without circular gates; all material changes invalidate the appropriate evidence; corruption remains explicit.

### P0.4 Propose, refine, and planning review

Target: design sections 7-12, 19, 21, 23 and 26. Evidence: [planning controller](../src/controller/planning.ts), [complexity policy](../src/controller/complexity-router.ts), [review controller](../src/controller/review.ts), [planning reviewer](../src/review/planning-reviewer.ts), [OpenSpec adapter](../src/openspec/adapter.ts).

- [ ] **Unwired:** implement change creation through the installed OpenSpec CLI and schema selection/installation. The adapter has status/instructions/apply/validate/archive but no change-creation method. Do not fork OpenSpec or hand-reimplement its change lifecycle.
- [ ] **Unwired:** supply `PlanningDependencies.runAgent` and `writeArtifacts`. Load artifact instructions/dependencies, invoke appropriate roles, validate model output, and write only the allowed proposal/spec/design/task artifacts with safe atomic writes. Generate the structured task metadata required by the parser.
- [ ] **Gap:** support resumable partial planning and refining all affected artifacts, including specs. Do not overwrite unrelated user edits or treat one synthesis string as proof that all artifacts were successfully written and validated.
- [ ] **Unwired:** derive and persist direct/bounded/architectural classification from actual scope, risk, and ambiguity signals, with explicit overrides and reasons. Use it for production fan-out instead of requiring an already-classified fixture input.
- [ ] **Gap:** add disagreement assessment between opinions and debate. The current controller enables debate from architectural class/budget alone. Skip debate on materially agreeing opinions even when budget is available; record why it was skipped. Budget is not a substitute for disagreement analysis.
- [ ] **Partial:** use compact decision capsules for handoff rather than forwarding every opinion/debate transcript to every subsequent invocation. Preserve full outputs as retrievable runtime evidence when needed.
- [ ] **Unwired:** assemble `reviewChange` with real author/model provenance, candidate availability, reviewed files, relevant current specs, repository context, and `runBrokeredPlanningReviewer`. Persist assignment, round, usage, and current digest-bound verdict.
- [ ] **Partial:** give review children the complete structured output contract, not only an instruction to return a matching object. Handle malformed output, unavailable reviewers, retries/timeouts, and cancellation without weakening independent review.
- [ ] **Partial:** route required findings back through artifact revision and fresh review. `reviewChange` currently returns `nextAction: review` after `REVISE`; surface an actionable revise-then-review loop, bounded by attempts/budget and human decisions where necessary.

Acceptance: a new change can be created and refined into valid executable tasks, reviewed by a real fresh read-only child, and become implementation-ready without editing runtime state by hand.

### P1.1 Worktree and execution pipeline

Target: design sections 13-19, 25-26, 29, 32 and 35. Evidence: [worktree manager](../src/execution/worktree.ts), [scheduler](../src/execution/scheduler.ts), [implementation flow](../src/execution/implementation-flow.ts), [task pipeline](../src/execution/task-runner.ts), [child spawn](../src/agents/spawn.ts), [task broker](../src/agents/task-broker.ts).

- [ ] **Unwired:** implement the production preparation sequence: OpenSpec status/apply instructions, current review verdict/digest, validated task metadata and scenario links, DAG compilation, persisted manifest/DAG, recovery reconciliation, worktree selection, then scheduling.
- [ ] **Acceptance risk:** define the planning-to-worktree artifact handoff. A new worktree starts at planning HEAD and does not contain uncommitted planning artifacts. Ensure agents see the reviewed artifacts without silently committing, copying unrelated dirty files, or establishing two authoritative task checklists.
- [ ] **Acceptance risk:** establish one writer-lease owner. The new scheduler acquires a lease; `createTaskBroker` independently acquires one for write tasks. Reusing the adapter unchanged can double-acquire. Pass/validate the existing lease or choose a single owner and verify release/revocation under failure.
- [ ] **Unwired:** implement a real `runBuilder` using brokered fresh task sessions, validated scopes, model routing, task capsule, compact policies, and structured outcomes. A generated session ID or an `execute` callback does not itself launch an isolated agent.
- [ ] **Unwired:** implement trusted `runVerification`, `runReview`, and `persistEvidence` dependencies. Invoke real commands through structured audited profiles, use the task code-review dispatcher with a real read-only child, and derive acceptance from actual outputs/digests.
- [ ] **Gap:** persist blocked, awaiting-user, design-conflict, failed-test, and rejected-review evidence as well as success. `runTaskPipeline` currently bypasses `persistEvidence` on those exits and treats non-completed builder outcomes as `evidencePersisted: true` without persisting them there.
- [ ] **Partial:** add bounded repair/re-review cycles. Rejected verification/review currently returns `blocked`; scheduler retry applies to `failed`, not that repair state. Preserve findings, use fresh reviewers, and do not blindly replay a builder that already changed source.
- [ ] **Unwired:** persist each accepted task result/review/report before updating its checkbox, then persist runtime completion. Reparse the latest task document or otherwise preserve source offsets; avoid overwriting earlier completions or concurrent user edits with stale document contents.
- [ ] **Unwired:** handle design conflicts as a controlled return to planning: persist evidence, stop affected dependents, release writer ownership, revise artifacts, invalidate/re-run review, rebuild the DAG, and reconcile surviving task evidence before resuming.
- [ ] **Acceptance risk:** test mixed read/write tasks, two ready writers, failed predecessors, user cancellation, simultaneous commands, and crashes between source write, review, evidence write, and checkbox update. No duplicate writes and no dependent dispatch before gates pass.

Acceptance: a two-task real change runs in its intended worktree with one source writer, fresh task contexts, actual verification/review, durable reports, and correct OpenSpec checkboxes.

### P1.2 Context, model routing, and compact policies

Target: design sections 14-17, 20-23, 30-32. Evidence: [role sessions](../src/agents/role-runner.ts), [TDD policy](../src/policies/tdd.ts), [failure records](../src/execution/recovery.ts).

- [ ] **Unwired:** build context sources from real task-linked requirements/scenarios, design decisions, project rules, relevant code, and accepted dependency reports. The task capsule assembler and its context ranking were removed as unconnected code; if context ranking is wanted it returns with a call site that exists.
- [ ] **Partial:** include the complete task capsule in the builder prompt. The task pipeline currently supplies a short task description and no dependency reports to `runFreshRoleTask`, despite the role runner supporting them.
- [ ] **Gap:** add a reachable authorized context-request path to child tooling. Bind requests to parent-owned run/task identity and remaining budget; account cumulatively for returned content. There is no escalation path today.
- [ ] **Partial:** estimate the actual serialized prompt, including dependency reports, available references, policy, and system prompt overhead. Do not trust a caller-provided required-token estimate as the full assembled cost; required content must never be silently truncated.
- [ ] **Unwired:** populate model capabilities from Pi's configured/authenticated model registry and existing Fusion stack, then route all roles consistently. Preserve role quality requirements and fresh/different-model review preference under budget pressure; report no eligible model rather than guessing availability.
- [ ] **Decision:** reconcile Pi-native `github-copilot` provider support with the router's requirement for a `vscode-copilot` adapter. Explore follows the Pi/Fusion model stack while the new router rejects that provider without the separate adapter. Distinguish provider access through Pi from a future VS Code execution host; confirm supported behavior with a live smoke test.
- [ ] **Partial:** validate model configuration errors and expose effective role/model/thinking/timeouts. `resolveExploreModel` currently suppresses config-load errors and falls back to a hardcoded provider. Missing authentication must produce direct setup guidance, never a secret request in chat.
- [ ] **Unwired:** deliver compact role contracts and stage-specific TDD/debugging/review/validation policy to real children. Measure against the original prompt-size targets; do not inject the full methodology into every invocation.
- [ ] **Unwired:** connect TDD records to trusted command events and source revisions, with requirement/scenario/test identity and reviewed non-applicability. Schema-valid builder claims alone must not establish RED/GREEN evidence.
- [ ] **Unwired:** connect unexpected failures to persisted debugging state, a reproduction, evidence, falsifiable hypothesis, minimal repair, and regression verification. Merely exhausting retries and returning `debugging` is not the systematic debugging workflow.

Acceptance: consecutive builders receive distinct sessions and relevant bounded context, can request authorized additions, use valid configured models, and cannot complete behavior changes without trustworthy policy evidence.

### P1.3 Final verification and explicit finish

Target: design sections 17, 27-29, 35 and 39. Evidence: [validator](../src/review/validator.ts), [verification controller](../src/controller/verify.ts), [finish controller](../src/controller/finish.ts), [verification artifact](../src/review/verification-artifact.ts).

- [ ] **Unwired:** implement every `FinalValidatorDependencies` collector against current OpenSpec, real task/results/reviews/reports, command execution, Git, worktree, leases, and checkpoints. Collect from the accepted execution worktree.
- [ ] **Gap:** supply actual fresh read-only validator reasoning for behavioral coverage, design alignment, and unexplained deviations. `runFinalValidation` allocates a session identity and evaluates supplied collectors; it does not itself spawn a validator model.
- [ ] **Partial:** reconcile exact task identities and requirement/scenario evidence across parsed tasks, OpenSpec apply output, test results, and reviews. Current task validation checks counts/description uniqueness rather than establishing a complete identity/coverage mapping.
- [ ] **Unwired:** execute required focused commands and project full suites through trusted command profiles, with output evidence, exit codes, timeouts, and source binding. Do not substitute builder claims or fixture `PASS` values.
- [ ] **Acceptance risk:** define mandatory suites and documented non-applicability for docs-only/direct work without silently skipping correctness. The current validator requires scenario links and a full suite for every task set; the original design permits applicability distinctions.
- [ ] **Unwired:** generate durable verification from collected evidence: commands/results, scenario coverage, resolved/unresolved findings, deviations, warnings, source/artifact digests, and final diff/commit information. Keep raw transcripts in runtime storage.
- [ ] **Unwired:** assemble explicit finish with current digests and the typed OpenSpec archive adapter. Verify does not archive/commit/merge/push/delete; finish delegates archive semantics only and reports archive paths/warnings.
- [ ] **Acceptance risk:** make archive failure/retry/restart idempotent through OpenSpec state inspection. Refresh active-change/run status after success; never emulate delta-spec merge or move directories manually.

Acceptance: first-time verification passes only on independent current evidence; source/planning edits block finish; explicit finish delegates once to OpenSpec and reports a traceable archived result.

### P1.4 Recovery, checkpoints, and runtime ownership

Target: design sections 18-19, 26, 29, 32, 35 and 37, plus the later OpenSpec manual-interaction requirements. Evidence: [recovery planner](../src/controller/recovery.ts), [checkpoint controller](../src/controller/manual-checkpoint.ts), [resume controller](../src/controller/implement.ts), [run records](../src/persistence/records.ts), [usage/store namespace](../src/persistence/change-usage-store.ts).

- [ ] **Unwired:** collect real child PID/session/exit state, lease ownership, checkpoints, task evidence, Git state, and OpenSpec state on command entry/restart, then execute every recovery-plan action. Planning an action is not recovery execution.
- [ ] **Gap:** establish distinct run/attempt identities and a canonical change-to-run lookup shared across planning checkout and worktree. The current deterministic `run-<slug>` namespace and cwd-local stores can conflate attempts or split a change's history between checkouts.
- [ ] **Unwired:** persist manifests, immutable DAG snapshots, briefs, results, task reviews, validation, model assignments, and writer lifecycle at the required boundaries. Validate schema migrations and corruption; raw runtime state must never override current OpenSpec/Git facts.
- [ ] **Unwired:** connect planned manual metadata and runtime prohibited-action classification to broker/scheduler checkpoints before the action occurs. Pause only affected dependents, revoke writer ownership, and allow safe unrelated branches to proceed.
- [ ] **Unwired:** restore pending instructions prominently on session startup and status; wire explicit resume to the exact checkpoint, change, run, and confirming user. Recheck expected outcome and freshness before requeueing; never auto-confirm a secret, privilege, destructive, or external action.
- [ ] **Gap:** define how ordinary interrupted/failed/cancelled execution resumes without a manual checkpoint. The parser requires a checkpoint for `resume`, while `implement` allows only READY/IMPLEMENTING and some failure states lead only to status. Provide a reachable, safe retry/recovery route.
- [ ] **Acceptance risk:** test mixed checkpoint/unrelated-task states through the command dispatcher, not just the scheduler. Snapshot derivation currently collapses any pending checkpoint into global `AWAITING_USER`; ensure this does not prevent allowed independent progress or hide work still running.
- [ ] **Acceptance risk:** verify all specified interruption points with real files/processes, including crash after review before checkbox, missing worktree, stale/live lease, corrupt/missing evidence, and archive handoff. Recovery must review existing writes rather than duplicate them.
- [ ] **Partial:** define retention and cleanup for transcripts, sessions, audit output, and old attempts. Cleanup must preserve required acceptance evidence and never remove user worktrees without the explicit lifecycle policy.

Acceptance: restarting the extension reconstructs the right run, shows pending human work, and safely continues from evidence rather than rerunning accepted writes.

### P1.5 One safety path

Target: design sections 3-6, 19, 24, 29-35. Evidence: [authorization](../src/tools/authorization.ts), [host runner](../src/tools/host-runner.ts), [task broker](../src/agents/task-broker.ts).

- [ ] **Acceptance risk:** preserve one writer/worktree/authorization policy across commands and tools, including architect artifact writes and future Serena mutation. Test canonical/symlink/case boundaries, recursive reads/search results, subprocess mutations, and lease revocation at the actual broker boundary.
- [ ] **Acceptance risk:** test migration against real structured task artifacts, including older unsupported metadata with actionable remediation. Do not silently accept incomplete metadata or maintain a second durable plan.
- [ ] **Partial:** retain the honest host-execution security notice. Brokered/audited execution is implemented; operating-system filesystem/network isolation remains deferred below. Neither library coverage nor UI labels establish containment.

Acceptance: every command and tool shares the same writer, worktree and authorization policy, and diagnostic commands do not bypass writer coordination.

### P1.6 Telemetry and compact run summaries

Target: design sections 2, 18, 21-23, 32 and 38. Evidence: [usage records](../src/telemetry/usage.ts), [change usage store](../src/persistence/change-usage-store.ts), [budgets](../src/telemetry/budget.ts), [production runtime](../src/change/dependencies.ts).

- [ ] **Partial:** instrument every production invocation, including explore, opinions, debate, synthesis, builder retries, task reviews, final validator, failures, and cancellations. Explore currently discards its `AgentRun` usage when returning model/content; legacy recording is only a partial path.
- [ ] **Partial:** preserve provider input/cache-read/cache-write/output/cost fields at event ingestion. The legacy aggregate adapter cannot recover cache fields and treats zero cost as unknown. Distinguish exact zero, unavailable cost, estimated cost, and partial totals.
- [ ] **Partial:** planning now connects a phase budget ledger to preflight usage and opinion/debate/synthesis forecasts, with configurable token/cost caps. Extend the same live usage and forecast enforcement to implementation, review, and validation; mandatory work must block explicitly rather than disappear.
- [ ] **Unwired:** populate policy/OpenSpec/repository/dependency/peer/tools/duplicate context categories, failure/retry outcomes, and skipped-work reasons from actual runs. Mark estimates as estimates.
- [ ] **Unwired:** expose compact run and per-change summaries in persistent command output/status, including classification, role/model assignment, phase costs, cache usage, retries, review findings, and optional work skipped. Existing `renderChangeStatus` shows only coarse total/phase usage and freshness.
- [ ] **Acceptance risk:** make usage idempotent across retries/recovery, avoid double-counting live and completed runs, and ensure redaction is applied at the production sink. Keep model/tool transcripts out of OpenSpec and report insufficient comparison data honestly.

Acceptance: visible and persisted totals reconcile to actual invocations across all phases, including interrupted ones, without invented cache/cost/savings precision.

### P2 Optional integrations and cost validation

Target: design sections 20-23, 30-31, 33 and 38-40. Evidence: [optional adapters](../src/integrations/optional-adapters.ts), [later design decisions](../openspec/changes/build-openspec-multi-agent-harness/design.md).

- [ ] **Unwired:** provide actual capability probes and read providers for configured Serena/Hindsight services. Current adapters accept supplied callbacks; core production does not discover/connect these services. Missing optional services must not block startup.
- [ ] **Unwired:** prefer authorized symbolic/relevant Serena context when configured; route its writes through the same lease and path enforcement. Test attempted scope/role bypasses at the provider integration boundary.
- [ ] **Partial:** merge supplemental memory below authoritative OpenSpec/repository facts, including semantic contradictions rather than only matching object keys. Do not merely append conflicting facts to the prompt and leave precedence entirely to the model.
- [ ] **Gap:** establish reproducible representative baseline/candidate workloads and capture tokens, cost, duration, retries, review failures, final-validation findings, and escaped defects. Keep workload/model/configuration provenance so comparisons are meaningful.
- [ ] **Gap:** run the comparative experiment for the original 25-50% token-reduction hypothesis only after real workflows work. Demonstrate no quality regression; reports accepting supplied comparison data are not measured benchmark results.
- [ ] **Partial:** optimize measured duplication/fan-out/context sizes, then rerun quality gates. The later OpenSpec design intentionally defers a statistical optimization release gate; do not claim that it has already been met.

### Acceptance, packaging, and documentation

Target: design sections 6-8, 33, 37, 39 and 40. Evidence: [extension smoke](../tests/extension/install-smoke.test.ts), [fixture lifecycle tests](../tests/e2e/change-lifecycle.test.ts), [production tests](../tests/muster/production-runtime.test.ts), [package scripts](../package.json), [provider doctor](../scripts/doctor.ts), [testing guide](testing.md).

- [ ] **Gap:** add default-production assembly tests, keeping mocking at external process/model boundaries rather than replacing controllers/handlers. Fail when any advertised action lacks its real handler; test real artifacts and changing digests.
- [ ] **Gap:** implement the live acceptance entry point referenced by OpenSpec task 13.6. `acceptance:live` is not a current package script. Exercise installed extension -> real Pi child -> broker -> real Git/worktree/OpenSpec -> verification, with no automatic commit/archive.
- [ ] **Partial:** expand installation smoke beyond command registration/help to schema availability, child broker loading, configured provider selection, tool authorization, durable output, and absence of reliance on a sibling checkout.
- [ ] **Acceptance risk:** verify packaging includes all referenced runtime/schema/license assets and reproducible dependency metadata. Do not infer distribution readiness from source checkout imports.
- [ ] **Partial:** validate the installed OpenSpec capability contract, supported Pi/Bun/Node versions, cwd semantics, archive behavior, and provider smoke on a clean project. The schema test already invokes the real CLI, but does not prove the whole default workflow.
- [ ] **Partial:** complete native Linux/macOS/Windows acceptance, including cancellation, subprocess cleanup, paths, symlinks, worktrees, and real command output. Correct platform-dependent fixture assertions and document actual environmental prerequisites rather than declaring a passing matrix from local tests.
- [ ] **Partial:** complete OpenSpec tasks 13.4-13.7: hosted matrix confirmation, provider readiness, live acceptance, and final documentation. The provider doctor checks auth/model discovery, not a complete model execution lifecycle.
- [ ] **Gap:** reconcile checked command/integration tasks with production evidence. In particular, the checked 11.x/12.x items and README describe workflows not available through default handlers. Record corrective OpenSpec work rather than treating all library checkmarks as delivered features.
- [ ] **Partial:** document installation, schema setup, configuration precedence, supported providers, task metadata, current command availability, output/cancellation behavior, worktree/artifact ownership, recovery, manual checkpoints, security limitations, and unverified savings. Fix the existing documentation fence failure.
- [ ] **Gap:** add release acceptance that requires visible user-facing output and real default command execution, not merely types, registration, and fixture orchestration. Retain a reviewed, versioned evidence record for the shipped build.

### Decisions not to mistake for missing features

The [later OpenSpec design](../openspec/changes/build-openspec-multi-agent-harness/design.md) deliberately tightens or narrows the original target:

| Original proposal | Current contract | Follow-up |
| --- | --- | --- |
| Three review verdicts, including `APPROVE_WITH_CHANGES`. | Binary `APPROVE`/`REVISE`; any required correction blocks. | Preserve the stricter gate unless OpenSpec explicitly changes; align the original design/reference docs. |
| Simple task checkbox examples with richer runtime metadata. | Every executable task requires adjacent structured YAML metadata. | Document/generate valid metadata; define migration for ordinary existing OpenSpec tasks. |
| Generic future host adapters. | Pi is the execution host; a separate VS Code Copilot adapter is deferred. | Do not conflate that host adapter with a provider already accessible through Pi. |
| Cost reduction as final success criterion. | Correctness-ready beta with savings still a hypothesis. | Keep comparative benchmarking open without making unsupported savings claims. |
| General finish/branch-completion semantics. | Explicit finish delegates archive only, with no automatic merge/push/delete. | Preserve explicit boundaries; any additional branch workflow needs its own approved contract. |
| Compact observability summary. | `/change` renders responsive agent columns while agents run. | Deliver the requested UI parity as an explicit acceptance requirement. |

### Suggested delivery order

1. Visible agent execution and results (P0.2), then real OpenSpec state and freshness (P0.3).
2. Bounded repair and design-conflict handling (P1.1), context and model routing (P1.2), final verification (P1.3).
3. Recovery and runtime ownership (P1.4), telemetry (P1.6).
4. Native-platform and live acceptance, then optional integrations and the comparative cost and quality benchmark (P2).

The simplification series measures its own claim (fewer sessions and tokens for small changes) with the manual acceptance run in [the simplification record](simplification.md), not with this roadmap.

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
