## Context

See `proposal.md` for motivation. Two modules dominate the `/change` surface by size and by responsibility count: the implementation runner and the dispatcher.

The implementation runner defines its three agent-invocation routines as closures nested inside the callback the scheduler invokes per task. Each closure captures the run identity, the store, the model stack, the document, the worktree, the observer, and the options. That capture is why they cannot be invoked in isolation: there is no way to supply those values except by constructing the entire run. The module already declares substitution points for exactly these three steps, which means the seams are known — they are simply not where the implementations live.

The dispatcher owns parsing, dispatch, rendering, classification, and registration. Its classification section is the part most frequently edited.

This change is sequenced last of the four. Splitting before the directory consolidation would move files twice; splitting the classification section before it becomes a declaration would extract literal sets into their own module and lock in the shape that the preceding change removes.

## Goals / Non-Goals

**Goals:**

- Each agent-invocation step becomes a top-level unit with explicit inputs, testable without driving a run.
- Each dispatch responsibility gets one owner.
- Concerns belonging to other layers move to those layers.
- Focused tests exist for steps that previously had none.
- No behavior change.

**Non-Goals:**

- Changing how tasks are scheduled, how the writer lease works, or how permissions are enforced.
- Changing prompts, agent roles, or model assignments.
- Changing persisted record shapes.
- Changing the public dispatch surface's exported entry points.
- Introducing new abstraction layers or indirection beyond the split itself.

## Decisions

### 1. The three agent-invocation steps become top-level functions taking an explicit context

Each step takes one context value carrying what it needs — run identity, store, model stack, observer, worktree, task, and cancellation — plus the step's own inputs. The review step additionally takes the builder and verification results it reviews, which today it reads from the enclosing scope.

The orchestration builds the context once per run and passes it to whichever steps it invokes. The existing substitution points keep their meaning: a substituted step replaces the default function rather than a closure, so substitution and the default now have the same signature. That is the property that makes the default independently testable.

Alternative considered: keep the closures and extract only the prompts. Rejected because the prompts are not the reason the steps are untestable; the captured run state is.

### 2. Orchestration keeps the run, and only the run

After the split, the orchestration module resolves the change, loads the validated task document, compiles the task graph, selects the worktree, establishes or validates the run manifest, computes recovery actions, drives the scheduler, and records results. Everything it does is about the run as a whole. The per-task agent work lives in the three step modules.

The result schema for builder results moves with the builder step, since it describes that step's output.

### 3. Embedded concerns move to their owning layers

- Verification command parsing → execution layer. It is already imported by a second consumer, which currently reaches into the orchestration module to get it.
- Persisted record reading → persistence layer, beside the store and schemas it composes.
- Validated-task to collaboration-task adaptation → beside the collaboration task type it produces.

Each of these has or will have more than one consumer; none of them is about orchestrating a run.

### 4. Dispatch splits along its five responsibilities

Parsing, dispatch, rendering, classification, and registration each become a module. The classification module receives the declaration produced by the preceding change, not the literal sets — this is the reason for the sequencing. The existing exported entry points are preserved by re-exporting them from the surface, so no consumer changes.

The lifecycle-blocker construction currently embedded in the dispatcher is presentation of a lifecycle decision, not the decision itself; it moves with rendering, while the decision remains with the existing action resolver.

### 5. Tests are added for the steps that gain testability

Each extracted step gets focused tests covering its success result, its failure result, and its cancellation behavior, with the agent invocation substituted at the child-process boundary. These tests do not exist today because they could not: the step could not be reached without a run. The existing orchestration tests are kept as-is to demonstrate the run still behaves identically.

### 6. Split in two independent halves

The implementation split and the dispatch split share no code and can be done in either order or in parallel. They are kept in one change because they are the same kind of work with the same acceptance criteria, and because reviewing them together makes the shared standard visible.

## Risks / Trade-offs

- **The implementation runner is the least test-covered module by proportion, and it is being restructured.** Mitigated by making each step's extraction a mechanical lift of an existing closure body into a function whose parameters are exactly the values it captured, and by adding the focused tests in the same step as the extraction rather than afterward.
- **More files to navigate.** Accepted: the number of concepts is unchanged, and each is now findable by name instead of by scrolling. The orchestration module remains the entry point.
- **Preserving exported entry points through re-exports adds indirection.** Accepted as the cost of not breaking consumers; the re-export surface is small and explicit.
- **Sequencing dependency on two preceding changes.** If either is deferred, this change should be deferred, because it would otherwise move files twice or extract the wrong shape of classification.

## Migration Plan

1. Extract the builder step to a top-level function with explicit inputs; move its result schema with it; add focused tests.
2. Extract the verification step the same way; add focused tests.
3. Extract the review step the same way, taking the builder and verification results explicitly; add focused tests.
4. Move the verification command parser, record reader, and collaboration-task adapter to their owning layers.
5. Split the dispatch module into parsing, dispatch, rendering, classification, and registration; preserve exported entry points by re-export.
6. Confirm the run and the command surface behave identically against the existing suites.

No data migration and no persisted format change.

## Open Questions

None. Whether the three step contexts share one type or declare three is an implementation detail resolved during extraction; the specification requires only that each step's dependencies be explicit in its inputs.
