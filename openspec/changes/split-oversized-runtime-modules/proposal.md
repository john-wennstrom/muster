## Why

Two modules in the `/change` surface each carry several unrelated responsibilities, and both are the largest files in the source tree.

The implementation runner is the single largest module. Alongside orchestrating a task run, it contains the builder result schema, a shell-safe verification command parser, a persisted record reader, a collaboration-task adapter, and three substantial agent-invocation routines defined as closures nested inside the task-execution callback. Because the three routines are closures, they capture the surrounding run state and cannot be read, tested, or replaced independently — the only way to exercise the builder invocation is to drive an entire task run.

The dispatcher module likewise holds five responsibilities: parsing the command line, dispatching to handlers, rendering outcomes, classifying raised failures, and registering the command with the host. Its failure-classification section alone is a dense block of literal sets and nested conditionals, which is precisely the part most often edited and least easily reviewed.

The consequence is not merely size. Nested closures cannot be unit-tested; a module with five responsibilities makes every change to one of them touch a file that three other concerns depend on; and a reviewer cannot tell from a diff which responsibility a change affects.

## What Changes

- Split the implementation runner so that task-run orchestration, builder invocation, verification invocation, and review invocation are separate modules, with the three invocation routines becoming top-level functions taking explicit inputs instead of closures capturing run state.
- Move the incidental concerns currently embedded in the implementation runner — the verification command parser, the persisted record reader, and the collaboration-task adapter — to the layers that own them.
- Split the dispatcher module so that parsing, dispatching, outcome rendering, failure classification, and host registration are separate modules.
- Add focused tests for the newly extracted agent-invocation routines, which are currently reachable only through a full task run.

Behavior is unchanged. The split makes previously untestable units testable and gives each responsibility one owner.

## Capabilities

### New Capabilities

- `command-module-decomposition`: The decomposition contract for the `/change` surface's orchestration and dispatch modules — what a module may own, and the requirement that agent-invocation steps be independently addressable.

### Modified Capabilities

None.

## Impact

- **Implementation orchestration:** the task run, the builder step, the verification step, and the review step become separate modules with explicit inputs; the substitution points that already exist for these three steps become the natural seams.
- **Dispatch:** parsing, dispatch, rendering, classification, and registration become separate modules behind the existing public surface.
- **Other layers:** the verification command parser moves to the execution layer, the record reader to the persistence layer, and the collaboration-task adapter next to the collaboration type it produces.
- **Tests:** new tests cover each extracted agent-invocation routine directly; existing orchestration tests continue to cover the run as a whole.
- **Compatibility:** no command grammar, outcome, persisted format, or extension entry point changes.
- **Prerequisites:** this change assumes the consolidated module layout and the failure-classification declaration are already in place, so that the split lands in stable locations and the classification module is extracted as a declaration rather than as literal sets.
