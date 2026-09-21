# Command flow

Every slash command Muster registers, and what each one does step by step. The diagrams follow the code, not the design documents, so they show what runs today. Where a judgment call site or a controller exists but nothing calls it yet, the diagram marks it as not wired.

Sources: [dispatcher](../src/change/dispatch.ts), [command table](../src/change/commands.ts), [action resolver](../src/controller/action-resolver.ts), [snapshot](../src/controller/change-snapshot.ts), [planning phase](../src/change/phases/planning.ts), [review phase](../src/change/phases/review.ts), [implementation phase](../src/change/phases/implementation.ts), [verification phase](../src/change/phases/verification.ts), [finish phase](../src/change/phases/finish.ts). For what leaves the machine at each judgment call site, see the [security model](security.md).

Contents:

1. [Command surface](#1-command-surface)
2. [Dispatch pipeline](#2-dispatch-pipeline)
3. [Lifecycle](#3-lifecycle)
4. [Explore](#4-explore)
5. [Propose and refine](#5-propose-and-refine)
6. [Review](#6-review)
7. [Implement and resume](#7-implement-and-resume)
8. [One task through the pipeline](#8-one-task-through-the-pipeline)
9. [Verify](#9-verify)
10. [Finish](#10-finish)
11. [Status](#11-status)
12. [Judgment runtime](#12-judgment-runtime)
13. [Legacy and Fusion commands](#13-legacy-and-fusion-commands)

How to read the colors: [How to read the diagrams](#how-to-read-the-diagrams).

## How to read the diagrams

Two colors mark cost and outside calls. Everything uncolored is deterministic code that spends no tokens.

```mermaid
flowchart LR
  a["LLM session: spends model tokens<br/>a Pi child agent"]:::llm
  b["Jev call: one classifier request<br/>third-party egress, off unless MUSTER_JEV=1"]:::jev
  c["Both: a step that spawns agents<br/>and also makes Jev calls"]:::llmJev
  d["Plain code: no tokens, no egress"]
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
```

Red is an LLM session and green is a Jev call. A red node with a thick green border is a step that contains both, used in the overview diagrams where the individual calls are not drawn. Two Jev decisions, `context.capsule_ranking` and `debugging.thrash`, are built but not called anywhere, so they never appear in green.

Of the nine `/change` commands, `verify`, `finish` and `status` spend no tokens. `verify` runs nine deterministic gates and the test commands, and no agent is dispatched. The where-the-tokens-go breakdown and ways to reduce it are in [simplification.md](simplification.md).

## 1. Command surface

`registerMuster` in [src/muster/index.ts](../src/muster/index.ts) registers the `/change` command and the flags it reads from one entry point.

```mermaid
flowchart LR
  pi(["Pi host"]) --> ext["registerMuster"]
  ext --> fh["registerFusionHarness"]
  ext --> chg["registerChangeCommand"]

  subgraph change["/change - preferred workflow surface"]
    direction TB
    c1["explore prompt<br/>read-only, no change needed"]
    c2["propose change goal<br/>creates the change"]
    c3["refine change guidance"]
    c4["review change guidance"]
    c5["implement change"]
    c6["resume change checkpoint-id"]
    c7["verify change"]
    c8["finish change"]
    c9["status change<br/>read-only"]
  end
  chg --> change

  subgraph legacy["Deprecated aliases - print guidance, then run the old handler"]
    direction TB
    l1["/refine change"]
    l2["/implement change"]
    l3["/ship change"]
  end
  fh --> legacy

  subgraph openspec["OpenSpec helpers"]
    direction TB
    o1["/os-status change"]
    o2["/init"]
  end
  fh --> openspec

  subgraph fusion["Fusion Harness diagnostics and orchestration"]
    direction TB
    f1["/fh - list commands, toggle model bar"]
    f2["/fh-only - one slot"]
    f3["/fh-model - pick slot, model, thinking"]
    f4["/fh-system-prompt"]
    f5["/fh-reset"]
    f6["/fh-opinion - parallel read-only answers"]
    f7["/fh-debate - read-only debate rounds"]
    f8["/fh-fusion - research then one merge"]
    f9["/fh-collaborate - plan, DAG, one writer at a time"]
    f10["/fh-auto-validate - gate, build, fix loop"]
  end
  fh --> fusion

  l1 -. "same lifecycle check as" .-> c3
  l2 -. "same lifecycle check as" .-> c5
  l3 -. "same lifecycle check as" .-> c8
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
  class c2,c3,c4,c5,c6 llmJev
  class c1,l1,l2,f2,f6,f7,f8,f9,f10 llm
```

## 2. Dispatch pipeline

Every `/change` invocation runs this path. Only the handler differs between subcommands. The per-action flags come from [commands.ts](../src/change/commands.ts).

| Action | Argument shape | Change slug | Lifecycle gated | Read-only | Run identity |
| --- | --- | --- | --- | --- | --- |
| `explore` | free text (at least 1 word) | none | no | yes | none |
| `propose` | change + text | optional | no | no | per invocation |
| `refine` | change + text | required | yes | no | per invocation |
| `review` | change + text | required | yes | no | per invocation |
| `implement` | change only | required | yes | no | per change |
| `verify` | change only | required | yes | no | per change |
| `finish` | change only | required | yes | no | per change |
| `status` | change only | required | yes | yes | none |
| `resume` | change + exactly one checkpoint id | required | yes | no | per change |

```mermaid
flowchart TD
  start(["User types /change ..."]) --> reg["registered handler builds context<br/>actor, cwd, signal, sendMessage<br/>and an agent-progress observer"]
  reg --> inv["dependencies.forInvocation<br/>rebuild production deps for this cwd"]
  inv --> parse{"first word is a<br/>known action?"}
  parse -- no --> usage["notify usage line<br/>stop"]
  parse -- yes --> shape["parse remainder by argument shape<br/>free-text: whole rest is the prompt<br/>else: word 2 is the change, rest are arguments"]
  shape --> arity{"argument count within<br/>the action's arity?"}
  arity -- no --> blockedUsage["outcome: blocked<br/>summary is the action usage<br/>next: /change status change"]
  arity -- yes --> needsChange{"action needs a<br/>change slug?"}

  needsChange -- "none (explore)" --> run
  needsChange -- "optional or required" --> resolve["resolveChangeName<br/>validate slug, ask OpenSpec for status,<br/>reject slug collisions"]
  resolve --> explicit{"slug given<br/>explicitly?"}
  explicit -- yes --> found
  explicit -- no --> remembered{"active change<br/>remembered?"}
  remembered -- no --> notResolved{"change required?"}
  remembered -- yes --> found["change resolved"]
  notResolved -- yes --> blockedNone["outcome: blocked<br/>No change resolved<br/>next: /change propose change"]
  notResolved -- no --> gated

  found --> gated{"lifecycle gated?"}
  gated -- "no (propose)" --> activate
  gated -- yes --> snap["loadSnapshot<br/>OpenSpec + Git + review + validation + runtime"]
  snap --> resolveAction["resolveChangeAction<br/>explore, propose, status always allowed<br/>others need an allowed lifecycle"]
  resolveAction --> allowed{"allowed?"}
  allowed -- no --> blocker["outcome: blocked<br/>reason, blocker kind, exact next command<br/>pending checkpoint ids, stale digest, missing review.md"]
  allowed -- yes --> activate{"read-only?"}
  activate -- no --> touch["activateChange<br/>remember as the active change"]
  activate -- yes --> run
  touch --> run["createRunContext<br/>run id, models, output sink<br/>then call the action handler"]

  run --> handler["handler = one phase call<br/>see sections 4 to 11"]
  handler --> emit["emitOutcome"]
  emit --> render{"host has a<br/>message renderer?"}
  render -- yes --> panel["durable transcript panel<br/>tagged MUSTER_CUSTOM_TYPE"]
  render -- no --> toast["transient ui.notify toast"]
  handler -. "thrown error" .-> terr["terminalErrorOutcome<br/>classified failure outcome"]
  terr --> emit
```

## 3. Lifecycle

The controller derives a change's lifecycle from a `ChangeSnapshot`, never from anything a model reports. The command's allowed lifecycles are in [action-resolver.ts](../src/controller/action-resolver.ts).

| Command | Allowed lifecycles |
| --- | --- |
| `explore`, `propose`, `status` | any |
| `refine` | `PLANNING`, `REVIEW_REQUIRED`, `DESIGN_CONFLICT`, `BLOCKED` |
| `review` | `REVIEW_REQUIRED` |
| `implement` | `READY`, `IMPLEMENTING` |
| `resume` | `AWAITING_USER` |
| `verify` | `VERIFYING` |
| `finish` | `VERIFIED` |

When a command is refused, the "next" command comes from the current lifecycle: `PLANNING` and `DESIGN_CONFLICT` suggest `refine`, `REVIEW_REQUIRED` suggests `review`, `READY` and `IMPLEMENTING` suggest `implement`, `AWAITING_USER` suggests `resume`, `VERIFYING` suggests `verify`, `VERIFIED` suggests `finish`, and everything else suggests `status`.

### Derivation order

`deriveLifecycle` checks these in order and returns the first that matches.

```mermaid
flowchart TD
  s(["ChangeSnapshotInput"]) --> a{"OpenSpec planning<br/>complete?"}
  a -- no --> PLANNING
  a -- yes --> b{"pending manual<br/>checkpoint ids?"}
  b -- yes --> AWAITING_USER
  b -- no --> c{"review.md digest equals current<br/>artifact digest AND verdict APPROVE?"}
  c -- no --> REVIEW_REQUIRED
  c -- yes --> d{"any task in the<br/>run manifest is..."}
  d -- design_conflict --> DESIGN_CONFLICT
  d -- debugging --> BLOCKED
  d -- failed --> FAILED
  d -- cancelled --> CANCELLED
  d -- awaiting_user --> AWAITING_USER
  d -- none of those --> e{"every OpenSpec task<br/>checked?"}
  e -- yes --> f{"validation current for both<br/>artifact and source digests?"}
  f -- yes --> VERIFIED
  f -- no --> VERIFYING
  e -- no --> g{"any task running<br/>or completed?"}
  g -- yes --> IMPLEMENTING
  g -- no --> READY
```

### Transitions

Any non-terminal state can also move to `CANCELLED`. `FINISHING` and `COMPLETE` are in the transition table, but `deriveLifecycle` never returns them, because an archived change is no longer observable. `AWAITING_USER`, `DESIGN_CONFLICT`, `BLOCKED`, `FAILED` and `CANCELLED` are tracked per task and DAG branch, so unrelated branches keep running.

```mermaid
stateDiagram-v2
  [*] --> EXPLORE
  EXPLORE --> PLANNING: propose
  PLANNING --> REVIEW_REQUIRED: propose or refine wrote artifacts
  REVIEW_REQUIRED --> READY: review APPROVE
  REVIEW_REQUIRED --> PLANNING: review REVISE, then refine
  READY --> IMPLEMENTING: implement
  IMPLEMENTING --> VERIFYING: all tasks completed
  IMPLEMENTING --> AWAITING_USER: manual checkpoint
  IMPLEMENTING --> DESIGN_CONFLICT: builder reports a design conflict
  IMPLEMENTING --> BLOCKED: task blocked after retries
  IMPLEMENTING --> FAILED: unexpected failure
  AWAITING_USER --> IMPLEMENTING: resume confirms the checkpoint
  DESIGN_CONFLICT --> PLANNING: refine
  BLOCKED --> PLANNING: refine
  BLOCKED --> IMPLEMENTING: implement
  FAILED --> IMPLEMENTING: implement
  VERIFYING --> VERIFIED: verify PASS
  VERIFYING --> VERIFYING: verify FAIL
  VERIFYING --> IMPLEMENTING: a task is reopened
  VERIFIED --> FINISHING: finish
  FINISHING --> COMPLETE: OpenSpec archive
  FINISHING --> VERIFIED: archive refused

  READY --> REVIEW_REQUIRED: reviewed artifact edited
  IMPLEMENTING --> REVIEW_REQUIRED: reviewed artifact edited
  VERIFYING --> REVIEW_REQUIRED: reviewed artifact edited
  VERIFIED --> REVIEW_REQUIRED: reviewed artifact edited
  VERIFIED --> VERIFYING: source or artifact changed after verify

  COMPLETE --> [*]
  CANCELLED --> [*]
```

## 4. Explore

`/change explore <prompt>` investigates without creating a change or touching the lifecycle. It needs no OpenSpec change and no healthy snapshot.

```mermaid
flowchart TD
  a(["/change explore prompt"]) --> d["dispatch: change requirement none<br/>skip resolution, skip lifecycle gate,<br/>never activate a change"]
  d --> h["explore handler<br/>prompt is the whole remainder"]
  h --> m["resolve architect model<br/>MUSTER_ARCHITECT_MODEL or MUSTER_EXPLORE_MODEL<br/>then fh-config architect slot<br/>then --architect flag, then declared fallback"]
  m --> ctx["explore controller<br/>optional authoritative context and supplemental facts<br/>appended to the prompt"]
  ctx --> child["spawn one read-only architect child<br/>pi --mode json -p<br/>session dir under .fusion/runs/explore-id<br/>30 minute timeout"]
  child --> ok{"child result"}
  ok -- aborted --> cancelled["PROCESS_CANCELLED"]
  ok -- failed --> failed["EXPLORE_AGENT_FAILED"]
  ok -- ok --> out["outcome: success<br/>summary is the agent's final answer"]
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
  class child llm
```

## 5. Propose and refine

`/change propose <change> <goal>` creates a change and its planning artifacts. `/change refine <change> [guidance]` revises them. Both call `runProductionPlanning` with a different phase.

```mermaid
flowchart TD
  a(["/change propose or refine"]) --> gate{"phase"}
  gate -- "propose (not lifecycle gated)" --> pre
  gate -- "refine (PLANNING, REVIEW_REQUIRED,<br/>DESIGN_CONFLICT or BLOCKED)" --> early["fetch OpenSpec status early<br/>read review.md"]
  early --> rev{"latest verdict<br/>REVISE?"}
  rev -- yes --> fold["fold required changes and critical<br/>findings into the request text"]
  rev -- no --> pre
  fold --> pre

  pre["planning budget<br/>default 1,000,000 tokens and 1.50 USD<br/>MUSTER_PLANNING_MAX_TOKENS, MUSTER_PLANNING_MAX_COST_USD<br/>or --planning-max-tokens, --planning-max-cost"] --> jrt["create judgment runtime from the environment"]

  jrt --> jp{"judgment enabled?"}
  jp -- no --> agentPre
  jp -- yes --> cand["retrieve up to 10 candidate files by code<br/>600 byte excerpts, denylisted files excluded"]
  cand --> judgePre["judge planning.preflight<br/>disposition plus per-candidate relevance"]
  judgePre --> acted{"enforce mode<br/>and confident?"}
  acted -- yes --> compose["compose preflight from the judgment<br/>no agent runs, avoided cost recorded"]
  acted -- no --> agentPre

  agentPre["budget forecast for preflight<br/>blocked_mandatory throws BUDGET_EXHAUSTED"] --> pchild["bounded read-only architect child<br/>brokered tools, at most 6 read/search calls, low thinking<br/>candidates pre-loaded only in enforce mode that did not act"]
  pchild --> pparse["parsePreflight<br/>exactly one JSON object with disposition,<br/>summary, evidence paths, optional question"]
  compose --> disp
  pparse --> recon["reconcile record: which path produced it,<br/>agreement and evidence overlap in shadow mode"]
  recon --> disp{"disposition"}

  disp -- needs_clarification --> blockQ["outcome: blocked<br/>next is the specific question"]
  disp -- already_satisfied --> blockS["outcome: blocked<br/>evidence listed, asks which branch or entry point still fails"]
  disp -- proceed --> ph{"phase"}

  ph -- propose --> exists{"OpenSpec knows<br/>this change?"}
  exists -- no --> create["install fusion-driven schema if missing<br/>openspec create change with that schema"]
  exists -- yes --> st
  create --> st["OpenSpec status and artifact instructions<br/>for proposal, specs, design, tasks"]
  ph -- refine --> st

  st --> risk["resolve risk inputs<br/>pattern baseline for contract, migration,<br/>security boundary, design ambiguity"]
  risk --> jc{"judgment enabled?"}
  jc -- yes --> judgeC["judge planning.complexity"]
  judgeC --> merge["enforce and confident: replace pattern inputs<br/>otherwise keep the pattern values<br/>reconcile agreement with pattern"]
  jc -- no --> classify
  merge --> classify["classifyChange<br/>file count 2 or fewer low, up to 8 medium, more high<br/>capabilities 1 low, 2 medium, 3 or more high<br/>migration, security, ambiguity are high<br/>public contract is medium"]

  classify --> cls{"classification"}
  cls -- "direct (thinking low)" --> minimal
  cls -- "bounded (thinking medium)" --> minimal
  cls -- "architectural (configured thinking)" --> opt
  minimal["minimal route<br/>synthesis only"] --> synthF
  opt["forecast specialist opinions<br/>two or more parallel read-only children,<br/>one per builder slot in rotation"] --> optB{"optional budget<br/>available?"}
  optB -- no --> skipped["optional_skipped_budget<br/>synthesis only"]
  optB -- yes --> debate["forecast then run one debate child<br/>reads all opinions"]
  skipped --> synthF
  debate --> synthF

  synthF["mandatory synthesis budget forecast<br/>blocked_mandatory throws BUDGET_EXHAUSTED"] --> synth["synthesis child returns one JSON bundle<br/>proposal.md, design.md, specs/capability/spec.md, tasks.md"]
  synth --> write["writeArtifacts"]
  write --> v1["parse bundle, reject duplicate paths,<br/>reject paths outside the change root,<br/>require proposal, design, tasks and one capability spec"]
  v1 --> tq["assessTaskQuality: judge planning.task_quality<br/>only when judgment is enabled and tasks.md parses<br/>with at most 40 tasks, advice only"]
  tq --> files["write files to openspec/changes/change"]
  v1 -. "invalid bundle" .-> retry{"attempt below 2?"}
  retry -- yes --> resynth["synthesis again with the rejection reason<br/>fed back and a JSON escaping reminder"]
  resynth --> write
  retry -- no --> fail["PLANNING_ARTIFACT_INVALID"]
  files --> done["outcome: success<br/>task quality findings listed when enforce mode produced any<br/>next: /change review change"]
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
  class judgePre,judgeC,tq jev
  class pchild,opt,debate,synth,resynth llm
```

Each planning child records a usage entry in the change's run store, and the budget ledger is updated whether or not the child succeeded.

## 6. Review

`/change review <change> [guidance]` runs an independent, fresh-context planning review over the proposal, specs, design and tasks. It is only allowed in `REVIEW_REQUIRED`.

```mermaid
flowchart TD
  a(["/change review change guidance"]) --> g["lifecycle gate: REVIEW_REQUIRED only"]
  g --> setup["OpenSpec status, model stack, run id,<br/>usage store, judgment runtime"]
  setup --> tflag{"judgment enabled AND<br/>MUSTER_JEV_REVIEW_TRIAGE=1?"}
  setup --> notes{"judgment enabled?"}
  notes -- yes --> qn["read tasks.md, load still-current<br/>task quality notes from plan time"]
  notes -- no --> disc
  qn --> disc
  tflag --> disc["discover reviewed artifacts<br/>hash them into the artifact digest<br/>read existing review.md if any"]

  disc --> tri{"triage enabled?"}
  tri -- no --> disp
  tri -- yes --> capture["capture reviewed set:<br/>per-file digests, proposal text, design text"]
  capture --> assess["assessReviewTriage: judge review.triage<br/>only if: existing review is APPROVE,<br/>no guidance given, a retained copy exists,<br/>specs and tasks unchanged<br/>sends unified diffs of proposal and design"]
  assess --> carry{"immaterial edit, confident,<br/>and fewer than 3 carry-forwards in a row?"}
  carry -- no --> disp
  carry -- yes --> recheck{"artifact digest still<br/>the same?"}
  recheck -- no --> disp
  recheck -- yes --> carried["write review.md: APPROVE carried forward<br/>round plus 1, names basis digest, count, judged answers<br/>no reviewer runs"]
  carried --> okOut

  disp["dispatchPlanningReview<br/>fresh reviewer session, a model other than the<br/>author's preferred, else the same model,<br/>read tools only, brokered planning reviewer child"] --> parsed{"reviewer output is valid<br/>structured verdict?"}
  parsed -- yes --> after
  parsed -- no --> extract["judge review.extraction<br/>classify candidate lines of the reviewer prose<br/>extraction marked in review.md"]
  extract --> after["verdict APPROVE or REVISE<br/>critical findings, required changes, recommendations"]
  after --> same{"artifact digest unchanged<br/>while the reviewer ran?"}
  same -- no --> stale["REVIEW_ARTIFACT_INVALID"]
  same -- yes --> wr["write review.md<br/>round, model, artifact digest, verdict"]
  wr --> trecon{"triage enabled?"}
  trecon -- yes --> tr["reconcile triage record<br/>on APPROVE retain the approved set<br/>at most 3 retentions per change"]
  trecon -- no --> verdict
  tr --> verdict{"verdict"}
  verdict -- APPROVE --> okOut["outcome: success<br/>lifecycle becomes READY<br/>next: /change implement change"]
  verdict -- REVISE --> revise["outcome: blocked<br/>required changes listed<br/>next: /change refine change<br/>refine folds them into its prompt automatically"]
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
  class assess,extract jev
  class disp llm
```

## 7. Implement and resume

`/change implement <change>` compiles `tasks.md` into a dependency DAG and runs dependency-ready tasks in a dedicated worktree. `/change resume <change> <checkpoint-id>` confirms a pause and then runs the same flow.

```mermaid
flowchart TD
  a(["/change implement change"]) --> g["lifecycle gate: READY or IMPLEMENTING"]
  r(["/change resume change checkpoint-id"]) --> rg["lifecycle gate: AWAITING_USER<br/>exactly one argument"]
  g --> load
  rg --> load

  load["OpenSpec status and apply instructions<br/>hash reviewed artifacts<br/>load and validate tasks.md"] --> tv{"every checkbox has a valid<br/>harness-task metadata block?"}
  tv -- no --> tinv["TASK_DOCUMENT_INVALID or TASK_METADATA_INVALID"]
  tv -- yes --> dag["compile task DAG from dependsOn<br/>persist under the change run store"]
  dag --> wt["ensureChangeWorktree<br/>path: sibling .muster-worktrees/repo/change-slug<br/>branch: muster/change-slug from the planning HEAD<br/>reuse only if branch and repository identity match"]
  wt --> man{"run manifest exists?"}
  man -- yes --> idc{"manifest change, repository and<br/>worktree match the selection?"}
  idc -- no --> conflict["RECOVERY_STATE_CONFLICT"]
  idc -- yes --> chg{"artifact digest differs<br/>from the manifest's?"}
  man -- no --> newm["write manifest: lifecycle READY,<br/>tasks ready or completed,<br/>model assignments, worktree identity"]
  newm --> chg
  chg -- yes --> inval["recovery action invalidate_run"]
  chg -- no --> pend["recovery actions restore_checkpoint<br/>for each pending checkpoint"]

  inval --> flow
  pend --> flow{"which command?"}
  flow -- implement --> impl["implementChange<br/>runPreparedFlow"]
  flow -- resume --> found{"checkpoint id is pending<br/>in this run?"}
  found -- no --> badresume["MANUAL_RESUME_INVALID"]
  found -- yes --> confirm["confirmManualCheckpoint<br/>records who confirmed and when"]
  confirm --> impl2["runPreparedFlow with that checkpoint<br/>removed from the pending list"]

  impl --> rf
  impl2 --> rf["runImplementationFlow"]
  rf --> rec["run recovery actions"]
  rec --> fresh{"review current AND<br/>no invalidate_run action?"}
  fresh -- no --> rreq["status review_required<br/>next: /change review change"]
  fresh -- yes --> ronly{"recovery-only actions left?<br/>wait for child or lease, review existing changes,<br/>resume task review, synchronize completion"}
  ronly -- yes --> paused0["status paused"]
  ronly -- no --> sch["runChangeScheduler<br/>see section 8 for each task"]

  sch --> res{"scheduler states"}
  res -- "any design_conflict" --> dc["persist design_conflict on those tasks<br/>status design_conflict"]
  res -- "all completed" --> comp["status completed"]
  res -- "any awaiting_user" --> pau["status paused"]
  res -- otherwise --> blk["status blocked"]
  sch -. "any cancelled" .-> canc["manifest lifecycle CANCELLED"]

  comp --> mf["manifest lifecycle VERIFYING<br/>outcome: success<br/>next: /change verify change"]
  dc --> mf2["manifest lifecycle DESIGN_CONFLICT<br/>outcome: blocked<br/>next: /change refine change"]
  pau --> mf3["manifest lifecycle AWAITING_USER<br/>outcome: blocked, pending checkpoint kind<br/>next: /change resume change checkpoint-id"]
  blk --> mf4["manifest lifecycle BLOCKED<br/>outcome: blocked<br/>next: /change status change"]
  rreq --> out5["outcome: blocked, stale digest"]
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
  class sch llmJev
```

The scheduler runs at most one writing task at a time under a writer lease and lets read-only tasks run alongside. A task that throws is attempted a second time; see section 8 for what counts as a retry.

## 8. One task through the pipeline

This is the `execute` callback the scheduler runs for each dependency-ready task, in [implementation.ts](../src/change/phases/implementation.ts) and [task-runner.ts](../src/execution/task-runner.ts).

```mermaid
flowchart TD
  s(["scheduler picks a ready task<br/>dependencies completed"]) --> lease{"task writes files?"}
  lease -- yes --> wl["acquire the writer lease<br/>one writer at a time"]
  lease -- no --> man
  wl --> man{"task has a manual block?"}
  man -- yes --> ck["checkpointPlannedManualAction<br/>persist secret-free instructions,<br/>pause the affected DAG branch"]
  ck --> pau(["outcome awaiting_user"])
  man -- no --> t0["record attempt start time"]

  t0 --> route{"first attempt AND<br/>economy lane configured AND<br/>judgment enabled?"}
  route -- no --> prim["primary builder slot"]
  route -- yes --> jr["judge routing.task_model<br/>needs MUSTER_JEV_MODEL_ROUTING=1<br/>and MUSTER_BUILDER_ECONOMY_MODEL"]
  jr --> lane{"enforce mode AND confident:<br/>mechanical, low risk, narrow reach?"}
  lane -- yes --> eco["economy builder slot<br/>primary with only the model replaced"]
  lane -- no --> prim

  prim --> b
  eco --> b["fresh builder session<br/>brokered child in the change worktree<br/>declared scopes in the prompt<br/>8 hour timeout"]
  b --> cc["each brokered host command:<br/>rules, allowlist, profile, then<br/>judge command.classification with a 1.5 second bound"]
  cc --> claim{"builder claim"}
  claim -- blocked --> ob["evaluateTaskOutcome: blocked<br/>needs a reason"]
  claim -- design_conflict --> odc["evaluateTaskOutcome: design_conflict<br/>needs evidence, artifacts, affected tasks<br/>invalidates the planning review"]
  claim -- completed --> tdd{"TDD policy: behavior-changing task<br/>has failing-test-first evidence?"}
  tdd -- no --> tb["blocked: TDD evidence rejected"]
  tdd -- yes --> vb["forecast validation budget"]
  vb --> ver["run task.verify commands in the worktree<br/>host runner, verification profile<br/>bun, node, npm, npx, git, openspec only<br/>no shell operators, 120 second cap<br/>stop at the first non-zero exit"]
  ver --> vp{"all passed?"}
  vp -- no --> vf["not completed: verification failed"]
  vp -- yes --> rb["forecast review budget"]
  rb --> jf["judge review.task_focus<br/>diff excerpt up to 24,000 bytes,<br/>skipped when a changed path is denylisted"]
  jf --> rv["fresh read-only reviewer child<br/>contract, diff, test output, scopes, TDD evidence<br/>focus items only when enforce mode acted<br/>120 second timeout"]
  rv --> ap{"approved?"}
  ap -- no --> rp["blocked: findings become repair input"]
  ap -- yes --> pe["persistEvidence<br/>task-results, reviews/task, tdd, reports"]
  pe --> sync["tick the checkbox in tasks.md<br/>update manifest for this task"]
  sync --> rec["reconcile first-attempt outcome into<br/>task quality and routing decision records"]
  rec --> done(["outcome completed"])

  ob --> stuck(["outcome blocked<br/>dependents on this branch are blocked,<br/>unrelated branches continue<br/>a later /change implement runs it again"])
  tb --> stuck
  vf --> stuck
  rp --> stuck
  odc --> dcend(["outcome design_conflict"])

  t0 -. "any step throws:<br/>unparseable builder JSON, child crash, git error" .-> thr{"attempt below 2?"}
  thr -- yes --> again["second attempt<br/>always the primary builder,<br/>never the economy lane"]
  again --> t0
  thr -- no --> dbg(["outcome debugging<br/>lifecycle BLOCKED"])
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
  class jr,cc,jf jev
  class b,rv llm
```

A task gets a second attempt only when an attempt throws. A returned `blocked` outcome (the builder claimed it, TDD evidence was rejected, verification failed, or the reviewer asked for repair) is final for that run: it blocks the task's dependents and leaves everything else running. Two thrown attempts end in `debugging`, which the snapshot derives as `BLOCKED`.

Two judgment call sites are built but not connected to task execution yet, so nothing is sent for them: `context.capsule_ranking` (context capsule assembly) and `debugging.thrash` (the repair loop that records failures). The [security model](security.md) lists both with that caveat.

## 9. Verify

`/change verify <change>` runs fresh-context final verification. It is only allowed in `VERIFYING`, which is the state after every task is checked and before a current validation exists. No agent runs here: `runFinalValidation` opens a fresh session identity but every gate is a code collector, so this command spends no tokens. It only runs the test commands.

```mermaid
flowchart TD
  a(["/change verify change"]) --> g["lifecycle gate: VERIFYING"]
  g --> st["read in parallel:<br/>OpenSpec status, apply instructions,<br/>strict openspec validate"]
  st --> rd["read run manifest, task results, task reviews,<br/>dependency reports, checkpoints"]
  rd --> git["read worktree identity, status, worktree list<br/>source digest from the change worktree"]
  git --> plr["read review.md, artifact digest"]
  plr --> cmd["collectCommands<br/>every distinct task.verify command<br/>then the full suite: bun test, at the worktree root<br/>each through the host runner, verification profile"]
  cmd --> val["runFinalValidation - nine gates"]

  subgraph gates["Gates, each must pass"]
    direction TB
    g1["openspec: planning complete,<br/>all artifacts done, strict validation passes"]
    g2["tasks: all done, each linked to a requirement<br/>and scenario, each has a verify command"]
    g3["evidence: manifest present, every task has<br/>completed persisted evidence and an APPROVE review"]
    g4["tests: each focused command exited 0<br/>and the full suite exited 0"]
    g5["findings: no unresolved blocking review findings"]
    g6["design: design.md present, aligned, with evidence"]
    g7["freshness: artifact digest, source digest and<br/>planning review digest all current"]
    g8["reports: every task has a dependency report<br/>with evidence and nothing unresolved"]
    g9["repository: identity and worktree match the manifest"]
  end
  val --> gates
  gates --> res{"result"}
  res -- PASS --> wp["write verification.md and validation.json<br/>digests of artifacts and source recorded"]
  res -- FAIL --> wf["write verification.md and validation.json<br/>blocking reasons listed"]
  wp --> okOut["outcome: success<br/>lifecycle becomes VERIFIED<br/>next: /change finish change"]
  wf --> failOut["outcome: blocked, invalid evidence<br/>next: /change verify change after fixing"]
```

## 10. Finish

`/change finish <change>` never runs automatically after verification. It confirms the recorded verification is still current and hands archiving to OpenSpec.

```mermaid
flowchart TD
  a(["/change finish change"]) --> g["lifecycle gate: VERIFIED"]
  g --> rd["read verification.md"]
  rd --> n{"belongs to this change?"}
  n -- no --> e1["VERIFICATION_NOT_READY<br/>different change"]
  n -- yes --> p{"result PASS?"}
  p -- no --> e2["VERIFICATION_NOT_READY<br/>latest verification did not pass"]
  p -- yes --> dg["recompute artifact digest and<br/>worktree source digest"]
  dg --> f{"both equal the<br/>verified digests?"}
  f -- no --> e3["VERIFICATION_NOT_READY<br/>stale for OpenSpec artifacts and or source"]
  f -- yes --> ar["openspec archive change<br/>OpenSpec does the archiving"]
  ar --> ok["outcome: success<br/>Archived change as archive-name"]
```

Archiving does not merge the change branch. The implementation stays on `muster/<change>` in the sibling worktree until you merge or discard it.

## 11. Status

`/change status [change]` is read-only. It does not remember the change as active.

```mermaid
flowchart TD
  a(["/change status change"]) --> d["dispatch: read-only, so no activateChange"]
  d --> snap["load snapshot once per invocation"]
  snap --> ok{"snapshot readable?"}
  ok -- no --> b["outcome: blocked<br/>no readable production snapshot"]
  ok -- yes --> u["load usage summary from the run store"]
  u --> r["render:<br/>Change, Lifecycle, Review freshness,<br/>Validation freshness, pending checkpoint count,<br/>usage by phase, host execution notice"]
```

## 12. Judgment runtime

Every judgment call site goes through the same runtime in [src/judgment/ask.ts](../src/judgment/ask.ts). With judgment off, nothing is sent and behavior is exactly what it is without it.

```mermaid
flowchart TD
  s(["a call site asks a typed question<br/>about a state"]) --> en{"MUSTER_JEV = 1?"}
  en -- no --> off["disabled: fallback<br/>nothing sent"]
  en -- yes --> key{"MUSTER_JEV_API_KEY set?"}
  key -- no --> nc["not configured: fallback"]
  key -- yes --> mode{"MUSTER_JEV_MODE is<br/>shadow, enforce or unset?"}
  mode -- "any other value" --> inv["invalid configuration: fallback"]
  mode -- valid --> dflag{"call site has its own flag?<br/>review.triage: MUSTER_JEV_REVIEW_TRIAGE<br/>routing.task_model: MUSTER_JEV_MODEL_ROUTING"}
  dflag -- "set to something other than 1" --> off2["disabled: fallback"]
  dflag -- ok --> deny{"any declared source path is a<br/>credential file: .env, keys, .npmrc,<br/>.aws, .kube, and similar?"}
  deny -- yes --> refuse["refused, nothing sent"]
  deny -- no --> red["redact every string in the state<br/>bearer tokens, credential flags,<br/>key value secrets, private keys,<br/>secret URL parameters, the API key itself"]
  red --> size{"state plus longest question<br/>within 32,000 tokens, all questions<br/>within 64,000 tokens?"}
  size -- no --> refuse2["refused, states are never truncated"]
  size -- yes --> req["call the hosted classifier<br/>pinned model version"]
  req --> ver{"response from the<br/>pinned version?"}
  ver -- no --> disc["discarded: fallback"]
  ver -- yes --> rec["write decision record to the run store<br/>digest of the redacted state, never the state"]
  rec --> m2{"mode"}
  m2 -- shadow --> sh["record only<br/>caller behaves as without judgment"]
  m2 -- enforce --> conf{"gate says act:<br/>confident and unambiguous?"}
  conf -- no --> abst["abstain: caller behaves as without judgment"]
  conf -- yes --> act["outcome handed to the caller<br/>which may skip an agent, add advice,<br/>choose a model, or carry a review forward"]
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
  class req jev
```

The call sites, in the order they fire during a change:

| Order | Decision | Where | Can change behavior in enforce mode |
| --- | --- | --- | --- |
| 1 | `planning.preflight` | propose, refine | yes: skips the preflight agent |
| 2 | `planning.complexity` | propose, refine | yes: replaces pattern risk inputs |
| 3 | `planning.task_quality` | propose, refine, before writing artifacts | no: advice only |
| 4 | `review.triage` | review, needs its own flag | yes: can carry an approval forward |
| 5 | `review.extraction` | review, only for unstructured reviewer output | yes: extracts findings |
| 6 | `routing.task_model` | implement, first attempt, needs its own flag | yes: picks the economy lane |
| 7 | `command.classification` | implement, every brokered host command | yes: a non-none category denies the command |
| 8 | `review.task_focus` | implement, before each task review | no: adds focus to the reviewer prompt |
| - | `context.capsule_ranking` | not connected | - |
| - | `debugging.thrash` | not connected | - |

## 13. Legacy and Fusion commands

These commands were retired and are no longer registered. The diagram below is kept until the documentation refresh in the last change of the simplification series replaces it.

```mermaid
flowchart TD
  subgraph legacyBox["Deprecated aliases"]
    direction TB
    lr(["/refine, /implement, /ship change"]) --> notice["warning: prefer the /change equivalent"]
    notice --> lc{"controller configured?"}
    lc -- no --> old
    lc -- yes --> lg["resolveChangeAction for refine, implement or finish"]
    lg --> la{"allowed?"}
    la -- no --> lb["warning with reason and next command<br/>stop"]
    la -- yes --> old["old handler runs"]
    old --> o1["refine: read-only debate, revised design.md,<br/>then tasks.md, strict validate"]
    old --> o2["implement: pick next incomplete phase,<br/>collaborate, run verify commands, tick boxes"]
    old --> o3["ship: no unchecked tasks, strict validate,<br/>openspec verify if supported, archive"]
  end

  subgraph helpers["OpenSpec helpers"]
    direction TB
    os(["/os-status change"]) --> os1["status, tasks per phase"]
    ini(["/init"]) --> ini1{"openspec/config.yaml<br/>exists?"}
    ini1 -- yes --> ini2["nothing to do"]
    ini1 -- no --> ini3["run openspec init, 60 second cap<br/>may need an interactive terminal"]
  end

  subgraph fh["Fusion Harness"]
    direction TB
    fhc(["/fh"]) --> fh1["list every /fh-* command,<br/>toggle the multi-row model bar"]
    fo(["/fh-only slot prompt"]) --> fo1["run one configured slot,<br/>or arm the next plain prompt"]
    fm(["/fh-model"]) --> fm1["session-only slot, model, thinking choice,<br/>never rewrites YAML"]
    fs(["/fh-system-prompt"]) --> fs1["show the system prompt of every slot"]
    fr(["/fh-reset"]) --> fr1["fresh host session and fresh slot memories"]
    fop(["/fh-opinion prompt"]) --> fop1["every slot answers independently,<br/>strict read-only tools, compare opinions"]
    fd(["/fh-debate prompt"]) --> fd1["opening, rebuttal, closing rounds,<br/>every survivor sees every other opinion, no judge"]
    ff(["/fh-fusion prompt"]) --> ff1["all slots research in parallel read-only,<br/>one fresh FUSION agent merges and builds,<br/>every slot acknowledges the merged context"]
    fc(["/fh-collaborate prompt"]) --> fc1["every agent plans read-only,<br/>architect merges one delegation DAG,<br/>tasks run as dependencies clear,<br/>exactly one shared-CWD writer at a time"]
    fa(["/fh-auto-validate prompt"]) --> fa1["validator designs an acceptance gate first,<br/>builder builds, gate runs, failures feed back<br/>until pass or --max-validations, default 5"]
  end
  classDef llm fill:#f8d7da,stroke:#c0392b,color:#1a1a1a
  classDef jev fill:#d4edda,stroke:#1e8449,color:#1a1a1a
  classDef llmJev fill:#f8d7da,stroke:#1e8449,stroke-width:4px,color:#1a1a1a
  class o1,o2,fop1,fd1,ff1,fc1,fa1,fo1 llm
```
