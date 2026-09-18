## Context

See `proposal.md` for motivation. The repository declares its error codes as one union in the shared error module, and every raised harness failure carries one of those codes plus a details record. The `/change` dispatcher converts an escaped failure into an outcome by testing the code against five inline sets and then selecting a blocker kind through a nested conditional.

Nothing connects those two places. The analysis that motivated this change found unreachable branches testing codes that do not exist, thrown codes with no classification, and one phase raising another phase's code. Because the mapping is expressed as literals rather than as a declaration over the union, none of that was detectable by the compiler or by review.

This change is sequenced after the handler and layout changes because those move and rewrite the dispatcher's surroundings. Doing the classification work first would mean redoing it; doing it after means it lands in a stable location.

## Goals / Non-Goals

**Goals:**

- One exhaustive declaration from code to classification, checked by the compiler in both directions.
- Every thrown code classified, so no production failure reports without a blocker where one applies.
- Cancellation kept distinct from failure, as it is today.
- A declared code for unrecognized failures, so reported codes are always drawn from the declared set.
- Phase-accurate attribution for agent failures.

**Non-Goals:**

- Changing the outcome shape, the set of statuses, or the set of blocker categories.
- Changing which conditions phases treat as failures.
- Rewording every existing failure message.
- Changing how failures are persisted, beyond the codes they carry.
- Introducing user-configurable classification.

## Decisions

### 1. The mapping is a total record over the code union

The classification becomes one declaration whose key type is the error-code union. Because the record is total, adding a code to the union without adding a classification fails typechecking, and declaring a classification for a code outside the union fails typechecking. This is the mechanism that makes both drift directions impossible rather than merely discouraged.

Each entry declares the blocker category to report, or declares that the code is presented as a plain failure. Entries that always concern a specific artifact declare it, so the artifact does not have to be inferred at the point of failure.

Alternative considered: keep the sets but add a test that cross-checks them against the union. Rejected because a test detects drift after it is written, while a total record prevents it at the point the code is added, which is where the author has the context to classify it.

### 2. Unreachable classifications are resolved by deciding whether the condition is real

The model-availability classification tests three codes that the union does not declare. Two resolutions are possible per code: the condition is real and the code should be declared and raised where models are resolved, or the condition is not represented and the branch should be deleted. The reachable case matters to users — a model that is configured but not authenticated is a common, recoverable condition — so the intent is to declare a model-availability code and raise it from model resolution, and delete the remaining undeclared literals. Where the condition cannot be shown to be raised anywhere, the branch is deleted rather than kept as speculative.

### 3. Unclassified thrown codes are classified by what the user must do next

Codes reaching the dispatcher unclassified are grouped by the user action they imply: fix a planning artifact, satisfy a lifecycle prerequisite, resolve a version-control or worktree condition, or report an internal fault. Each group maps to an existing blocker category; no new category is introduced, because the existing set already covers the distinctions the interface renders.

### 4. Unrecognized failures get a declared code

The dispatcher currently substitutes an undeclared literal when an escaped error carries no code. That literal cannot be matched by any consumer of the declared set. A code reserved for unrecognized failures is declared and used instead, so the invariant "every reported code is a declared code" holds without exception. The failure remains presented as a plain failure with its description.

### 5. Planning agent failures get their own code

The planning runner raises the exploration failure code for planning agent failures. A planning-agent failure code is declared and raised instead. The exploration code keeps its meaning. This is an internal code and not part of the command grammar, so the only consumers to update are within the repository.

### 6. One test asserts the property the types already enforce, for the runtime side

Typechecking guarantees totality of the declaration. A test additionally asserts that raising each declared code through the dispatcher produces the declared status and blocker category, which covers the conversion logic rather than the table. Together these mean an added code is both classified and demonstrably presented as declared.

## Risks / Trade-offs

- **Classifying previously unclassified codes changes reported statuses.** A failure that reported a plain failure may now report as blocked. This is the intended correction, but it is user-visible; the tasks call for reviewing each newly classified code's status change deliberately rather than accepting it as incidental.
- **Declaring a model-availability code requires finding where it should be raised.** If no production path can raise it, the correct outcome is to delete the branch instead. The task is written to allow either resolution, with the requirement being that no classification survives for a code nothing raises.
- **Renaming the planning failure code breaks internal matches on the exploration code.** Mitigated by a repository-wide search for the exploration code as an explicit task step.
- **Sequencing dependency.** This change assumes the dispatcher has settled in its final location. If the preceding changes are deferred, this one can still be done, at the cost of reapplying it during the later move.

## Migration Plan

1. Declare the missing codes: planning-agent failure, unrecognized failure, and model availability if a raising path exists.
2. Replace the inline sets and nested conditional with the total classification declaration; delete classifications for codes that remain undeclared.
3. Classify the previously unclassified thrown codes, reviewing each resulting status change.
4. Raise the planning code from the planning runner and the model-availability code from model resolution; search the repository for remaining uses of the exploration code outside exploration.
5. Add the conversion test covering each declared code, and extend existing outcome tests for the newly classified conditions.

No persisted format changes. Persisted records written before this change retain the codes they were written with; nothing reads them for classification.

## Open Questions

None. Whether a model-availability code is declared or the branch is deleted is resolved during implementation by determining whether any production path raises the condition; both outcomes satisfy the specification.
