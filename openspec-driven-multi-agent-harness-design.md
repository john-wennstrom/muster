# OpenSpec-Driven Multi-Agent Development Harness

## Status

**Design proposal / implementation target**

This document defines the target architecture for a Pi-native AI development harness that combines:

- OpenSpec as the durable specification and change-management system.
- Fusion Harness as the runtime orchestration foundation.
- Selected Superpowers engineering disciplines, rewritten as deterministic runtime behavior and compact role policies.

The resulting system should be implemented as **one repository and one Pi extension**.

OpenSpec remains an external dependency and must not be forked or embedded into the harness.

---

## 1. Executive Summary

The harness must enforce one architectural rule above all others:

> **There SHALL be exactly one durable representation of project intent, design, requirements, and implementation tasks: OpenSpec.**

Fusion Harness supplies multi-model reasoning, delegation, execution, scheduling, model routing, writer coordination, and token accounting.

Superpowers is not retained as a second orchestration framework. Its strongest engineering practices are extracted and implemented as:

- deterministic runtime behavior where possible;
- short role-specific prompt contracts where judgment is required.

The target relationship is:

```text
OpenSpec
  durable WHAT + WHY
        │
        ▼
Unified Pi Harness
  reasoning + orchestration
        │
        ├── Fusion multi-model primitives
        ├── Superpowers-derived engineering policies
        ├── context assembly
        ├── model routing
        ├── review gates
        ├── writer lease
        └── token accounting
        │
        ▼
Repository
  code + tests + git
```

OpenSpec owns the development contract.

The harness executes the development contract.

---

## 2. Goals

The system SHALL optimize for the following priorities, in order:

1. Lower total LLM/token cost.
2. Higher implementation correctness.
3. Better architectural consistency.
4. Stronger review independence.
5. Deterministic orchestration.
6. Clear project history and traceability.
7. Minimal duplicated artifacts.
8. Support for multiple model providers and role-specific routing.
9. Strict read/write boundaries for agents.
10. Compatibility with Serena and Hindsight without making either authoritative.

The harness SHOULD remain usable with Pi as the primary host, while keeping internal components sufficiently generic that future adapters are possible.

---

## 3. Non-Goals

The system SHALL NOT:

- fork or reimplement OpenSpec;
- maintain a second permanent specification store;
- maintain a second permanent task plan;
- reproduce OpenSpec archive logic;
- make Hindsight or model memory authoritative project state;
- require all agents to load every engineering skill;
- keep long-lived builder conversations by default;
- allow multiple write-enabled agents to modify the same worktree concurrently;
- use debate by default when simpler adjudication is sufficient;
- optimize cost by silently removing mandatory correctness gates.

---

## 4. Architectural Principles

### 4.1 One durable source of truth

OpenSpec owns all durable project-change artifacts:

```text
proposal.md
design.md
specs/**/*.md
tasks.md
review.md
verification.md
archived changes
current capability specs
```

Fusion runtime artifacts such as delegation DAGs, builder reports, model opinions, debate transcripts, context packages, and token metrics are execution state.

They are not competing architectural truth.

### 4.2 Mechanics belong in code

Deterministic behavior SHALL be enforced in TypeScript rather than repeatedly described in prompts.

Examples:

- writer exclusivity;
- worktree creation;
- dependency ordering;
- task status;
- artifact freshness;
- review staleness;
- tool permissions;
- edit boundaries;
- model routing rules;
- context budgets;
- OpenSpec validation;
- test command execution;
- token accounting.

### 4.3 Judgment remains model-driven

Models are used for decisions requiring reasoning, including:

- architectural trade-offs;
- requirement interpretation;
- code implementation;
- design criticism;
- task decomposition;
- debugging;
- risk analysis;
- code review;
- acceptance judgment.

Mechanical orchestration should not consume frontier-model reasoning when normal code can perform it.

### 4.4 Fresh context by default

Models are roles, not permanent workers.

A builder working on Task 7 should normally receive curated context for Task 7, not the entire conversation history from Tasks 1–6.

### 4.5 Process rigor scales with risk

The runtime SHOULD classify work approximately as:

```text
DIRECT
  Small change.
  No behavioral contract change.
  Minimal orchestration.

BOUNDED
  Normal OpenSpec change.
  Limited multi-agent reasoning.
  Fresh builder + reviewer.

ARCHITECTURAL
  Cross-cutting, ambiguous, high-risk, or multi-domain.
  Multi-model opinions.
  Conditional debate.
  Strong architect/reviewer/validator.
```

This classification controls orchestration cost.

It does not remove engineering correctness requirements.

---

## 5. Responsibility Boundaries

| Concern | Owner |
|---|---|
| Current behavioral specifications | OpenSpec |
| Proposed behavioral changes | OpenSpec |
| Technical design | OpenSpec |
| Durable task checklist | OpenSpec |
| Durable pre-implementation review | OpenSpec |
| Durable verification summary | OpenSpec |
| Change archive/history | OpenSpec |
| Multi-model reasoning | Fusion runtime |
| Delegation | Fusion runtime |
| Task execution graph | Fusion runtime |
| Model routing | Fusion runtime |
| Writer exclusivity | Fusion runtime |
| TDD discipline | Harness policy + validator |
| Debugging discipline | Harness policy |
| Code review | Fusion reviewer |
| Worktrees | Harness runtime |
| Context selection | Harness runtime |
| Symbol/code navigation | Serena when configured |
| Supplemental memory | Hindsight when configured |
| Token/cost accounting | Harness runtime |
| Revision history | Git |

If Hindsight, Serena memory, or model conversation state conflicts with OpenSpec or repository state, OpenSpec/repository state wins.

---

## 6. Repository Architecture

Fusion Harness should be used as the runtime codebase foundation.

A target module layout is:

```text
src/
├── extension/
│   └── pi-extension.ts
├── controller/
│   ├── development-controller.ts
│   ├── complexity-router.ts
│   └── action-resolver.ts
├── openspec/
│   ├── adapter.ts
│   ├── types.ts
│   ├── status.ts
│   ├── instructions.ts
│   ├── validation.ts
│   └── archive.ts
├── fusion/
│   ├── child-runner.ts
│   ├── model-router.ts
│   ├── writer-lease.ts
│   ├── delegation-dag.ts
│   └── reasoning-primitives.ts
├── context/
│   ├── assembler.ts
│   ├── code-context.ts
│   ├── dependency-context.ts
│   ├── artifact-context.ts
│   └── budget.ts
├── policies/
│   ├── architect.ts
│   ├── builder.ts
│   ├── reviewer.ts
│   ├── validator.ts
│   ├── tdd.ts
│   └── debugging.ts
├── execution/
│   ├── worktree.ts
│   ├── task-runner.ts
│   ├── scheduler.ts
│   └── test-runner.ts
├── review/
│   ├── artifact-review.ts
│   ├── code-review.ts
│   ├── digest.ts
│   └── freshness.ts
├── persistence/
│   ├── run-store.ts
│   ├── manifest.ts
│   └── recovery.ts
└── telemetry/
    ├── usage.ts
    ├── budget.ts
    └── report.ts
```

Superpowers source SHOULD NOT simply be copied into this repository.

Its useful behavior must be selectively rewritten around this architecture.

---

## 7. OpenSpec Integration

### 7.1 OpenSpec remains external

The harness SHALL call OpenSpec through structured CLI commands.

The harness SHALL NOT:

- fork OpenSpec;
- vendor OpenSpec source;
- parse human-readable OpenSpec output when JSON exists;
- reimplement archive behavior;
- reimplement delta-spec merging;
- maintain duplicate OpenSpec state.

### 7.2 Required adapter surface

The OpenSpec adapter should expose functions equivalent to:

```ts
interface OpenSpecAdapter {
  detect(root?: string): Promise<OpenSpecEnvironment>;

  status(
    change: string,
    options?: OpenSpecOptions
  ): Promise<OpenSpecStatus>;

  artifactInstructions(
    change: string,
    artifact: string,
    options?: OpenSpecOptions
  ): Promise<ArtifactInstructions>;

  applyInstructions(
    change: string,
    options?: OpenSpecOptions
  ): Promise<ApplyInstructions>;

  validate(
    options?: OpenSpecOptions
  ): Promise<ValidationResult>;

  archive(
    change: string,
    options?: OpenSpecOptions
  ): Promise<ArchiveResult>;
}
```

Internally these SHOULD map to commands such as:

```bash
openspec status --change <change> --json

openspec instructions <artifact> \
  --change <change> \
  --json

openspec instructions apply \
  --change <change> \
  --json

openspec validate --json

openspec archive <change> --json
```

### 7.3 Fail closed

Malformed or incompatible JSON SHALL produce an explicit harness error.

The harness MUST NOT silently infer missing OpenSpec state.

### 7.4 Capability detection

Prefer capability detection over strict version checks.

Version constraints may be used as diagnostics but should not replace runtime validation of required machine-readable interfaces.

---

## 8. Harness OpenSpec Schema

The repository should provide a small OpenSpec schema intended for harness-controlled projects.

Example:

```yaml
name: fusion-driven
version: 1

artifacts:
  - id: proposal
    generates: proposal.md
    requires: []

  - id: specs
    generates: specs/**/*.md
    requires:
      - proposal

  - id: design
    generates: design.md
    requires:
      - proposal

  - id: tasks
    generates: tasks.md
    requires:
      - specs
      - design

  - id: review
    generates: review.md
    requires:
      - specs
      - design
      - tasks

  - id: verification
    generates: verification.md
    requires:
      - review

apply:
  requires:
    - review
  tracks: tasks.md
```

This schema describes artifact dependencies.

It MUST NOT contain the entire multi-agent orchestration algorithm as prose.

The runtime owns orchestration.

---

## 9. Durable Artifact Model

A change should normally look like:

```text
openspec/changes/<change>/
├── proposal.md
├── design.md
├── tasks.md
├── review.md
├── verification.md
└── specs/
    └── <capability>/
        └── spec.md
```

No equivalent permanent files should be created under:

```text
docs/superpowers/specs/
docs/superpowers/plans/
```

The harness should not create a permanent `plan.md`.

---

## 10. Pre-Implementation Review Gate

### 10.1 Purpose

`review.md` records whether the complete planned change is acceptable before implementation starts.

The reviewer receives:

- proposal;
- design;
- delta specs;
- tasks;
- relevant current specs;
- selected repository context.

### 10.2 Reviewer isolation

The reviewer SHALL:

- run in fresh context;
- be read-only;
- preferably use a different model from the architect;
- not inherit the architect transcript;
- not modify source or planning artifacts.

### 10.3 Artifact digest

The harness SHALL calculate a digest over the reviewed artifact set:

```text
proposal.md
design.md
tasks.md
specs/**
```

`review.md` SHOULD contain:

```text
Review round: 2
Artifact digest: sha256:<digest>

VERDICT: APPROVE

Critical findings:
None

Required changes:
None

Recommendations:
- Keep migration behind the existing feature boundary.
```

If any reviewed artifact changes, the review becomes stale.

The runtime, not the model, enforces staleness.

### 10.4 Verdicts

Supported verdicts should be minimal:

```text
APPROVE
APPROVE_WITH_CHANGES
REVISE
```

Implementation MUST NOT start while the latest review is stale or blocking.

---

## 11. Lifecycle

OpenSpec should remain fluid rather than becoming a rigid waterfall.

The harness derives current state from:

```text
OpenSpec status
+
review status
+
Git/worktree status
+
task state
+
current run state
```

A typical substantial change is:

```text
IDEA
 │
 ▼
EXPLORE
 │
 ▼
proposal
 │
 ├──────────────┐
 ▼              ▼
specs         design
 └──────┬───────┘
        ▼
      tasks
        │
        ▼
      review
        │
        ▼
    APPROVED
        │
        ▼
runtime task DAG
        │
        ▼
implementation
        │
        ▼
verification
        │
        ▼
OpenSpec archive
```

Implementation discoveries MAY cause a return to proposal, specs, design, or tasks.

Any material change to reviewed artifacts invalidates the review.

---

## 12. Exploration and Refinement

Exploration should create no durable artifact unless the user intentionally promotes it to an OpenSpec change.

The harness may use architect reasoning, specialist opinions, repository investigation, and disagreement analysis.

A high-level command such as:

```text
/change refine <change>
```

may internally perform:

```text
current OpenSpec artifacts
        │
        ▼
specialist opinions
        │
        ▼
disagreement analysis
        │
        ├── low disagreement
        │      ↓
        │   architect synthesis
        │
        └── material disagreement
               ↓
             debate
               ↓
        architect synthesis
               │
               ▼
          update design/specs/tasks
```

Debate is conditional.

Do not run multi-round debate merely because multiple models are available.

---

## 13. No Permanent `plan.md`

OpenSpec `tasks.md` is the permanent implementation checklist.

The harness compiles it into a richer runtime DAG.

Example OpenSpec tasks:

```markdown
- [ ] 2.1 Add repository abstraction
- [ ] 2.2 Implement API endpoint
- [ ] 2.3 Update frontend client
```

Runtime representation:

```text
T2.1
owner: backend
dependencies: []
writes: crates/service/**
tests: required

T2.2
owner: backend
dependencies: [T2.1]
writes: crates/api/**

T2.3
owner: frontend
dependencies: [T2.2]
writes: frontend/**
```

The runtime DAG MAY be persisted under:

```text
.fusion/runs/<run-id>/dag.json
```

It SHOULD normally be ignored by Git.

It is not architectural truth.

---

## 14. Agent Session Topology

Recommended session behavior:

```text
MAIN
  persistent
  human conversation only

ARCHITECT
  phase-scoped
  recreated for major planning revisions

BUILDER
  fresh per task

REVIEWER
  fresh per review

VALIDATOR
  fresh per completed change
```

Persistent role identity may exist in configuration.

Persistent conversational history should not.

---

## 15. Builder Task Capsule

Each builder receives a curated task package.

Example:

```ts
interface TaskCapsule {
  task: TaskDefinition;
  requirements: RequirementExcerpt[];
  scenarios: ScenarioExcerpt[];
  designDecisions: DesignDecision[];
  dependencyReports: DependencyReport[];
  projectRules: ProjectRule[];
  codeContext: CodeContextEntry[];
  allowedReads: string[];
  allowedWrites: string[];
  acceptance: AcceptanceCondition[];
  tokenBudget: TokenBudget;
}
```

The builder should not receive unrelated planning artifacts or previous builder transcripts unless explicitly needed.

---

## 16. Superpowers-Derived Policies

Superpowers should be treated as a methodology source rather than a runtime dependency.

Preserve the semantics of:

### Brainstorming

Implemented through exploration and Fusion-based design refinement.

### Test-driven development

Builder behavior follows:

```text
RED
 ↓
GREEN
 ↓
REFACTOR
```

Verification ensures relevant scenario/test evidence exists.

### Systematic debugging

When implementation fails unexpectedly, activate a dedicated debugging policy instead of trial-and-error patching.

The debugging policy should require:

1. reproduce;
2. gather evidence;
3. identify likely root cause;
4. test hypothesis;
5. apply minimal fix;
6. verify regression coverage.

### Requesting code review

Implemented as fresh-context reviewer invocations.

### Verification before completion

Implemented by the validator and mechanical gates.

### Git worktrees

Implemented by the harness worktree manager.

### Finishing a development branch

Implemented as the completion workflow.

The following Superpowers orchestration concepts should NOT remain as separate runtime systems:

```text
using-superpowers bootstrap
subagent-driven-development controller
executing-plans controller
dispatching-parallel-agents
writing-plans artifact generation
generic cross-harness mappings
```

Fusion/runtime code already owns those concerns more efficiently.

---

## 17. TDD and Specification Traceability

OpenSpec scenarios should become the behavioral anchor for testing.

```text
Requirement
   │
   ▼
Scenario
   │
   ▼
test evidence
   │
   ▼
RED
   │
   ▼
implementation
   │
   ▼
GREEN
   │
   ▼
refactor
```

Example trace:

```text
Capability:
session-management

Requirement:
Session expiration

Scenario:
Expired refresh token is rejected

Evidence:
crates/auth/tests/refresh.rs
::expired_refresh_token_is_rejected
```

The harness SHOULD record this mapping in runtime evidence and summarize important coverage in `verification.md`.

A separate permanent `test-plan.md` is not required unless a project explicitly chooses to add one.

---

## 18. Runtime Persistence

Raw model transcripts and tool traces should not pollute OpenSpec.

A run directory may contain:

```text
.fusion/runs/<run-id>/
├── manifest.json
├── dag.json
├── usage.json
├── tasks/
│   ├── 2.1/
│   │   ├── brief.md
│   │   ├── result.json
│   │   └── review.json
│   └── ...
└── validation.json
```

The run store should support interruption recovery.

Recommended manifest:

```ts
interface RunManifest {
  runId: string;
  change: string;
  root: string;
  worktree?: string;
  createdAt: string;
  updatedAt: string;
  state: RunState;
  artifactDigest?: string;
  taskIds: string[];
  currentWriter?: string;
  modelAssignments: Record<string, string>;
}
```

---

## 19. Writer Safety

Fusion's single-writer invariant SHALL remain.

Example role permissions:

```text
architect
  repository: read
  selected OpenSpec artifacts: write

backend builder
  backend: write
  frontend: read

frontend builder
  frontend: write
  backend: read

reviewer
  repository: read
  OpenSpec: read
  write: none

validator
  repository: read
  OpenSpec: read
  write: none
```

Only one source-writing task holds the global writer lease at any time.

Read-only reasoning MAY occur concurrently.

Serena write operations MUST respect the same writer lease and path restrictions.

---

## 20. Context Assembly

The context assembler SHALL distinguish:

```text
REQUIRED
  Must always be supplied.

RELEVANT
  Selected for the current task.

AVAILABLE
  Referenced by path and retrievable on demand.

EXCLUDED
  Known irrelevant.
```

A builder should not automatically receive the whole repository, whole proposal, whole design, all specs, all dependency reports, all previous discussions, and all engineering policies.

Context should be task-specific.

The runtime should support escalation:

```text
builder requests more context
        │
        ▼
context assembler validates relevance/budget
        │
        ▼
additional code/artifact slice supplied
```

---

## 21. Token Architecture

Target resident prompt sizes:

```text
global harness contract       < 800 tokens
architect contract          1,000–2,000
builder contract              700–1,200
reviewer contract             600–1,000
validator contract            600–1,000
```

The full methodology library should never be injected into every invocation.

### Debate cost

For N agents exchanging peer outputs, context cost grows roughly quadratically.

Therefore:

```text
debate only when disagreement is material
```

### Fusion result synchronization

Do not broadcast full fused outputs to every model.

Use a compact decision capsule:

```ts
interface DecisionCapsule {
  artifactPath: string;
  artifactDigest: string;
  decisionsChanged: string[];
  constraintsChanged: string[];
  responsibilities: string[];
}
```

Agents can read the full artifact when needed.

### Cost target

A reasonable engineering target is:

> **25–50% lower total token consumption than a layered OpenSpec + Fusion + Superpowers-skill workflow, without measurable review-quality regression.**

This is a hypothesis to validate experimentally.

---

## 22. Token Ledger

Every invocation SHOULD record:

```text
phase
agent role
model
task
input tokens
cache-read tokens
cache-write tokens
output tokens
estimated cost
```

Where practical, classify input usage as:

```text
policy
OpenSpec artifacts
code/repository
dependency handoff
peer-agent handoff
tool results
duplicate context
```

Example:

```ts
interface UsageRecord {
  runId: string;
  phase: string;
  role: string;
  model: string;
  taskId?: string;

  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;

  costUsd?: number;

  categories?: {
    policy?: number;
    openspec?: number;
    repository?: number;
    dependency?: number;
    peer?: number;
    tools?: number;
    duplicate?: number;
  };
}
```

---

## 23. Model Routing

Routing occurs at two levels.

### Work-level routing

```text
DIRECT
  one suitable model
  minimal ceremony

BOUNDED
  architect
  appropriate builder
  fresh reviewer

ARCHITECTURAL
  expert opinions
  optional debate
  architect synthesis
  multiple builders
  strong reviewer
  strong validator
```

### Task-level routing

Use cheaper capable models for localized implementation, mechanical refactors, repetitive test additions, and straightforward frontend/backend tasks.

Use stronger models for architecture, ambiguity resolution, adversarial review, design conflicts, final validation, and high-risk migrations.

The runtime should distinguish:

```text
cost-sensitive production work
```

from:

```text
quality-sensitive judgment
```

---

## 24. User-Facing Commands

Provide a high-level command surface:

```text
/change explore <idea>
/change propose <change>
/change refine <change>
/change review <change>
/change implement <change>
/change verify <change>
/change finish <change>
/change status <change>
```

Optional aliases may include:

```text
/refine <change>
/implement <change>
```

Existing Fusion expert commands MAY remain available for diagnostics and advanced workflows.

---

## 25. `/change implement`

Implementation should behave approximately as:

```text
/change implement auth-refresh
          │
          ▼
OpenSpecAdapter.status()
          │
          ├── prerequisites missing
          │      → stop with exact missing artifact
          │
          ▼
verify review digest
          │
          ├── stale
          │      → require review
          │
          ▼
OpenSpecAdapter.applyInstructions()
          │
          ▼
compile task DAG
          │
          ▼
create/select worktree
          │
          ▼
dependency-ready scheduler
          │
     ┌────┴─────────────┐
     │                  │
read-only work     writer task
may overlap             │
                        ▼
                  fresh builder
                        │
                  RED/GREEN/refactor
                        │
                        ▼
                  focused tests
                        │
                        ▼
                  fresh reviewer
                        │
               FAIL ────┴──── PASS
                 │                │
                 ▼                ▼
            fix/re-review     mark task complete
```

Dependents become eligible only when required predecessors have passed their configured gates.

---

## 26. Design Drift

Builders should be able to return:

```ts
type BuilderOutcome =
  | { type: "completed"; report: TaskReport }
  | { type: "blocked"; reason: string }
  | {
      type: "design_conflict";
      evidence: string[];
      affectedArtifacts: string[];
      recommendation?: string;
    };
```

When a `design_conflict` occurs:

1. stop affected dependent tasks;
2. return control to the architect;
3. update design/specs/tasks as needed;
4. invalidate review;
5. re-review;
6. resume eligible work.

This is expected iterative behavior, not a runtime failure.

---

## 27. Verification

The harness SHALL provide one verification path combining the useful semantics of OpenSpec verification, Fusion validation, and Superpowers verification-before-completion.

Verification checks at least:

```text
all required OpenSpec tasks complete
OpenSpec validation passes
required behavior is implemented
scenario/test evidence exists where applicable
focused tests pass
required full test suites pass
review findings resolved
implementation matches current design
no unexplained design drift
pre-implementation review is current
no blocking builder reports remain
repository/worktree state is understood
```

The validator SHALL:

- run in fresh context;
- normally be read-only;
- produce evidence;
- not rely on builder claims alone.

`verification.md` SHOULD summarize durable evidence such as task completion, test commands/results, spec coverage, important implementation deviations, review results, warnings, and final diff/commit information.

---

## 28. Archiving

The harness MUST NOT implement archive semantics itself.

When verification passes, delegate to:

```bash
openspec archive <change> --json
```

OpenSpec remains responsible for:

- delta spec synchronization;
- current spec updates;
- retirement semantics;
- archive naming;
- archive movement;
- OpenSpec validation behavior.

---

## 29. Worktree Strategy

Worktree ownership belongs in the harness.

A practical default:

```text
planning:
  main checkout or current development checkout

implementation-ready:
  create/select dedicated change worktree

implementation:
  all writers operate only inside that worktree

verification:
  run inside that worktree

archive/finalization:
  performed once implementation is accepted
```

Child agents SHALL NOT independently create nested worktrees.

Only the controller/worktree manager manages workspace topology.

---

## 30. Serena Integration

Serena is a code navigation and editing implementation detail.

Read tools may be available broadly.

Write tools are available only when:

- the current role is write-enabled;
- the writer lease is held;
- the target path is within the role's allowed write scope.

Serena MUST NOT become a bypass around normal file access restrictions.

The context assembler SHOULD prefer symbolic/relevant reads over large raw file dumps when Serena can obtain more compact code context.

---

## 31. Hindsight Integration

Hindsight may provide supplemental project or developer memory.

It is not authoritative.

Appropriate use:

```text
coding conventions
past implementation pitfalls
project preferences
non-critical prior decisions
```

Inappropriate use:

```text
current requirement truth
current OpenSpec change status
current architecture
current task completion state
```

When memory contradicts OpenSpec or repository state, discard the memory for the current decision.

---

## 32. Failure Philosophy

The harness should fail closed where correctness is affected.

```text
invalid OpenSpec JSON
→ stop

missing required artifact
→ stop

stale review digest
→ stop

reviewer unavailable
→ retry allowed reviewer or fail

writer lease conflict
→ block second writer

builder reports design conflict
→ return to architecture

expected RED-stage test failure
→ continue TDD

persistent unexpected failure
→ activate debugging policy

token budget exceeded
→ reduce optional fan-out

mandatory validation failure
→ never silently skip
```

Budget pressure may remove optional opinions, a second debate round, or optional exploratory models.

Budget pressure must not silently remove required tests, required review, required validation, or OpenSpec integrity.

---

## 33. Migration From Fusion Harness

Implementation should be incremental.

### Stage A — Baseline measurement

Measure representative current workloads:

```text
tokens
cost
duration
review failures
task retries
defects found during final validation
```

### Stage B — OpenSpec adapter

Implement:

```text
detect
status
artifact instructions
apply instructions
validate
archive
```

Do not change current Fusion execution yet.

### Stage C — Unified artifact model

Add the `fusion-driven` schema.

Stop producing competing permanent planning artifacts.

### Stage D — Fresh task sessions

Change persistent builder sessions into role/model definitions.

Spawn fresh builder contexts per task.

### Stage E — Policy extraction

Port from Superpowers:

```text
TDD
debugging
review
verification
worktree discipline
branch-completion discipline
```

Do not port its generic orchestration framework.

### Stage F — Review gate

Implement:

```text
fresh reviewer
read-only enforcement
artifact digest
staleness detection
verdict parsing
```

### Stage G — Runtime DAG and scheduler

Compile OpenSpec tasks into a dependency DAG.

Maintain the single-writer invariant.

### Stage H — Context compiler

Implement task capsules and explicit token budgets.

### Stage I — High-level workflow commands

Expose `/change ...`.

Keep low-level Fusion commands for advanced use.

### Stage J — Optimization

Use token ledger data to reduce actual measured waste.

---

## 34. Explicitly Rejected Designs

### Layer OpenSpec + Superpowers + Fusion unchanged

Rejected because all three retain overlapping orchestration and prompt payloads.

### Merge OpenSpec into the harness repository

Rejected because OpenSpec has its own lifecycle, machine interface, and release cadence.

### Keep Superpowers `plan.md`

Rejected because OpenSpec already owns task state and Fusion already needs a runtime DAG.

### Keep persistent builder conversations

Rejected as the default because context grows unnecessarily and contaminates unrelated tasks.

### Load all skills into all agents

Rejected because most instructions are irrelevant to most invocations.

### Let architect self-review

Rejected because fresh-context independent review is materially stronger.

### Store Fusion runtime state as architectural truth

Rejected because OpenSpec is the canonical durable change-history system.

### Run debate automatically

Rejected because peer-context fan-out can become one of the largest token costs.

---

## 35. Core Runtime Invariants

The implementation MUST enforce these invariants.

1. **Single durable planning truth** — no permanent competing proposal/design/task hierarchy outside OpenSpec.
2. **Single source writer** — at most one task agent holds the source writer lease for a worktree.
3. **Fresh review** — a reviewer may not reuse the authoring session being reviewed.
4. **Review freshness** — material artifact changes invalidate prior approval.
5. **OpenSpec state wins** — runtime state may not override OpenSpec truth.
6. **No silent quality degradation** — cost limits may reduce optional reasoning, never required correctness gates.
7. **Task-scoped context** — builders receive minimum necessary context and may request more.
8. **Runtime DAG is derived** — execution graph is reconstructable from OpenSpec tasks plus runtime metadata.
9. **Permissions are enforced outside prompts** — read/write boundaries are runtime constraints.
10. **Verification requires evidence** — no task/change is accepted solely on an agent's completion claim.

---

## 36. Initial TypeScript Domain Model

```ts
type WorkClass =
  | "direct"
  | "bounded"
  | "architectural";

type AgentRole =
  | "architect"
  | "builder"
  | "reviewer"
  | "validator";

type ReviewVerdict =
  | "approve"
  | "approve_with_changes"
  | "revise";

interface ChangeContext {
  name: string;
  root: string;
  schema: string;
  changeDir: string;
  proposal?: string;
  design?: string;
  specs: string[];
  tasks?: string;
  review?: string;
  verification?: string;
}

interface TaskDefinition {
  id: string;
  description: string;
  done: boolean;
  dependencies: string[];
  preferredRole?: string;
  allowedWrites?: string[];
}

interface DependencyReport {
  taskId: string;
  summary: string;
  filesChanged: string[];
  interfacesChanged: string[];
  testsAdded: string[];
  warnings: string[];
}

interface TaskReport {
  taskId: string;
  summary: string;
  filesChanged: string[];
  testsRun: string[];
  testsAdded: string[];
  requirementEvidence: string[];
  dependencyImpact: string[];
  warnings: string[];
}

interface ReviewResult {
  verdict: ReviewVerdict;
  artifactDigest: string;
  critical: string[];
  requiredChanges: string[];
  recommendations: string[];
}

interface ValidationResult {
  passed: boolean;
  blocking: string[];
  warnings: string[];
  evidence: string[];
}
```

These are starting points, not fixed public APIs.

---

## 37. Testing Strategy for the Harness

### OpenSpec adapter tests

Test:

- valid JSON;
- malformed JSON;
- missing OpenSpec executable;
- missing change;
- incompatible payload shape;
- archive failure;
- validation failure.

### Writer lease tests

Test:

- one writer succeeds;
- second writer blocks;
- lease releases on normal exit;
- lease is recoverable after child crash;
- read-only tasks remain concurrent.

### Review freshness tests

Test:

- unchanged artifacts remain approved;
- design modification invalidates review;
- spec modification invalidates review;
- tasks modification invalidates review;
- irrelevant runtime file does not invalidate review.

### Scheduler tests

Test:

- dependencies enforce ordering;
- independent reads can overlap;
- write tasks serialize;
- failed task blocks dependents;
- design conflict halts affected branch;
- retry resumes correctly.

### Context budget tests

Test:

- required context is never omitted;
- optional context is truncated before required context;
- full artifacts can be replaced with references when allowed;
- token budget escalation works.

### Recovery tests

Test interrupted runs:

- before builder start;
- during builder;
- before review;
- after task review;
- before final validation.

Recovery must not duplicate completed source writes.

---

## 38. Observability

The harness should expose a compact run summary.

Example:

```text
Change: notification-refactor
Class: architectural

Planning
  architect      18.2k tokens
  opinions       11.4k
  debate          0.0k  skipped: low disagreement
  review           8.6k

Implementation
  builders        41.1k
  task reviews    19.8k

Validation
  validator        7.4k

Total
  input/cache/output: ...
  estimated cost: ...

Saved
  debate skipped: estimated -14k tokens
  fresh-task context: estimated -23k repeated context
```

The goal is to expose enough evidence to make optimization decisions.

---

## 39. Success Criteria

The system is successful when all of the following are true.

### Correctness

No implementation can complete without satisfying current OpenSpec state and required quality gates.

### Single source of truth

No duplicate permanent proposal/design/task/plan hierarchy is generated.

### Isolation

Write scopes and the writer lease are enforced independently of agent compliance.

### Review independence

Artifact and code review run in fresh context.

### Freshness

Changing reviewed artifacts mechanically invalidates prior approval.

### Recovery

Interrupted runs can resume from OpenSpec, Git, and minimal runtime persistence.

### Cost

Representative substantial changes consume materially fewer tokens than the layered baseline.

### Quality

Cost reduction does not increase escaped defects or final-review findings.

### Traceability

An archived OpenSpec change contains enough durable information to understand:

- why the change occurred;
- what behavior changed;
- the technical design;
- implementation tasks;
- review outcome;
- verification evidence.

### Upgradeability

OpenSpec can be upgraded without modifying harness core code unless its machine contract changes.

---

## 40. Recommended Implementation Order for Codex Agents

Agents implementing this design SHOULD work in this order unless repository constraints justify otherwise:

1. Inspect current Fusion Harness architecture and tests.
2. Add baseline token/run metrics before changing behavior.
3. Implement OpenSpec JSON adapter and typed payload validation.
4. Add project schema bundle for `fusion-driven`.
5. Introduce run-store persistence without changing scheduling.
6. Implement artifact digest and review freshness.
7. Implement fresh-context reviewer abstraction.
8. Refactor model slots from persistent conversations into role configurations.
9. Implement fresh builder-per-task execution.
10. Compile OpenSpec tasks into a runtime DAG.
11. Integrate the existing single-writer lease with DAG execution.
12. Implement context capsules and token budgets.
13. Port compact TDD/debugging/verification policies.
14. Add high-level `/change` command routing.
15. Add final verification and archive delegation.
16. Run comparative benchmarks against the baseline.
17. Optimize based on measured token/cost data.

Each step should preserve a working harness.

Avoid a large rewrite that removes existing Fusion functionality before equivalent replacement behavior is tested.

---

## 41. Agent Development Rules

When implementing this design:

1. **Inspect before changing.** Reuse existing Fusion abstractions where they already satisfy the requirement.
2. **Prefer runtime enforcement over prompt instructions.** Do not solve deterministic constraints with longer system prompts.
3. **Do not create duplicate durable artifacts.** OpenSpec remains the source of truth.
4. **Preserve backwards compatibility where practical.** Low-level existing Fusion commands may remain available.
5. **Keep model-provider concerns behind interfaces.** Role behavior must not depend on one provider.
6. **Add tests with each architectural change.** Particularly writer safety, review freshness, recovery, and OpenSpec parsing.
7. **Measure token behavior.** Do not claim an optimization without usage evidence.
8. **Fail explicitly.** Never silently degrade from review/verification to unchecked implementation.
9. **Prefer small incremental refactors.** Every stage should leave the repository buildable and testable.
10. **Document deviations.** If repository reality requires changing this design, update the design before introducing contradictory architecture.

---

## 42. Final Architecture

```text
                  OpenSpec
             ┌────────────────┐
             │ WHY            │
             │ WHAT           │
             │ DESIGN         │
             │ TASKS          │
             │ REVIEW         │
             │ VERIFICATION   │
             │ HISTORY        │
             └───────┬────────┘
                     │
                     ▼
          Unified Development Harness
      ┌────────────────────────────────┐
      │ Fusion reasoning               │
      │ Superpowers-derived discipline │
      │ context compiler               │
      │ model router                   │
      │ DAG scheduler                  │
      │ writer lease                   │
      │ review/validation gates        │
      │ token ledger                   │
      └───────────────┬────────────────┘
                      │
        ┌─────────────┼───────────────┐
        │             │               │
   Architect       Builders        Reviewer
        │             │               │
        └─────────────┼───────────────┘
                      ▼
                  Validator
                      │
                      ▼
                 Git Repository
```

The implementation must preserve this boundary:

> **OpenSpec stores the development contract. The harness executes, reviews, and verifies that contract.**
