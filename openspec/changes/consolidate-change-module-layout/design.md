## Context

See `proposal.md` for motivation. Today the `/change` surface spans `src/muster/` (nine command files plus the extension entry point) and `src/runtime/` (dispatcher, shared command types, dependency assembly, agent progress, manual interface, and three phase runners). `src/runtime/command.ts` imports two phase option types from `src/muster/`, closing a cycle between the directories.

This change is deliberately sequenced after `unify-change-handler-runtime`. That change makes the nine handlers uniform and thin; moving them first would relocate code about to be rewritten, and would make the rewrite's diff unreadable because every file would appear both moved and changed.

This change is also deliberately separated from splitting the two oversized modules. Moving a 583-line module and then splitting it are independently reviewable; doing both at once produces a diff in which nothing can be verified as a pure move.

## Goals / Non-Goals

**Goals:**

- One directory for the `/change` surface, with a handler layer and a phase layer.
- A placement rule that does not depend on how many actions use a phase.
- Handler modules that contain only argument interpretation and one phase call.
- A one-directional dependency between the layers, with the existing cycle removed and guarded.
- Documentation and instruction files updated in the same change as the move.

**Non-Goals:**

- Changing any behavior, command grammar, outcome shape, lifecycle rule, or persisted format.
- Splitting oversized modules, which is a separate change.
- Changing the error classification logic, which is a separate change.
- Changing the legacy Fusion harness layout, which remains where it is.
- Changing the registered extension entry point's external path or signature.

## Decisions

### 1. One surface directory with `handlers/` and `phases/` subdirectories

```
src/change/
  handlers/{explore,propose,refine,review,implement,resume,verify,finish,status}.ts
  phases/{planning,review,implementation,verification,finish,status}.ts
  dispatch.ts  register.ts  outcome.ts  branding.ts  handler.ts  commands.ts  dependencies.ts
  agent-progress.ts  manual-ui.ts  snapshot.ts
```

The rule becomes positional and needs no exception: if it is invoked by a handler and does real work, it is a phase; if it interprets arguments and calls one phase, it is a handler. Shared dispatcher, registration, rendering, branding, metadata, and assembly modules sit at the surface root, above both layers.

Alternative considered: keep two directories and merely reverse the option-type imports to break the cycle. Rejected because it leaves the unpredictable placement rule intact — the cycle is a symptom, not the problem.

Alternative considered: one directory per action, each containing its handler and phase. Rejected because planning and implementation phases are each shared by two actions, so those phases would have no home under that scheme — the same defect in a new shape.

### 2. Review, verification, and finish phase logic moves into `phases/`

These three currently live inside their command files. After the move, `handlers/verify.ts` holds only the handler, and `phases/verification.ts` holds the runner, matching `handlers/propose.ts` and `phases/planning.ts`. Verification's command-parsing helper, which currently lives in the implementation runner and is imported by the verify command file, moves to the execution layer where its two consumers can both reach it without either importing the other.

### 3. Phase option types move with their phases, which breaks the cycle

Each phase's options type is declared beside its runner in `phases/`. The shared command types module references those types, and handlers reference them, but nothing in `phases/` or in the shared types references a handler module. The dependency direction becomes handlers → phases → shared libraries, with the surface-root modules depended on by both layers and depending on neither.

The cycle removal is asserted by a test that walks the surface's import graph, so the property is enforced rather than merely established once.

### 4. The extension entry point keeps its external path

The module named by the packaged extension manifest keeps its current path and default-export signature; internally it re-exports from the new surface directory. This keeps the packaging and install-smoke paths untouched, so a packaging failure during this change would be attributable to something other than the move.

### 5. Move in dependency order, one commit per group, with imports updated mechanically

Shared surface modules move first, then phases, then handlers, then the assembly and entry point. Each group's commit updates only import paths outside the moved files. Typechecking after each group catches a missed reference immediately, and no group leaves the tree in a state where behavior differs.

### 6. Documentation is updated in the same change

The repository agent guidelines, the `/change` wiring instructions, and any roadmap or design references that name surface paths are updated alongside the move. This is treated as part of the work rather than follow-up because stale path references in this repository have previously caused real defects: a child-process broker path and a documentation-check import both silently pointed at a pre-rename location after an earlier directory rename.

## Risks / Trade-offs

- **Large diff touching many files.** Mitigated by moving in dependency-ordered groups, by each group being a pure move plus import updates, and by typechecking between groups. Reviewers can verify each group by confirming file contents are unchanged apart from import lines.
- **Merge conflicts with concurrent work on the surface.** Mitigated by sequencing this change immediately after the handler unification, before further phase work begins, and by completing it in a short sequence of commits rather than a long-lived branch.
- **Stale references outside the source tree.** Mitigated by a repository-wide search for the old directory names as an explicit task, and by the existing documentation-link check.
- **Prerequisite coupling.** This change depends on `unify-change-handler-runtime` having landed. If that change is deferred, this one should be deferred with it rather than reordered.

## Migration Plan

1. Move shared surface modules (dispatcher, registration, rendering, branding, metadata, handler contract, agent progress, manual interface, snapshot loading) into the surface directory.
2. Move phase runners, including the review, verification, and finish logic extracted from their command files, and relocate the verification command-parsing helper into the execution layer.
3. Move phase option types beside their phases and update the shared command types to reference them.
4. Move the nine handler modules.
5. Move the dependency assembly; make the manifest entry point re-export from the surface directory.
6. Update tests, scripts, agent guidelines, wiring instructions, and roadmap or design references; add the import-cycle assertion; search the repository for remaining references to the old directory names.

No data migration and no persisted format change.

## Open Questions

None. The surface directory name is a naming preference; if the maintainer prefers a different name, it is a single rename applied before step one and affects nothing else in this design.
