## Context

See `proposal.md` for motivation. The `/change` surface is assembled from `src/runtime/change-command.ts` (parse, dispatch, render, classify, register), `src/runtime/dependencies.ts` (assembly), `src/runtime/command.ts` (outcome and options types), three shared phase runners (`planning.ts`, `implementation.ts`, `snapshot.ts`), and nine per-command files in `src/muster/`.

Each handler was wired in a separate slice, so the shape drifted. This change makes the shape uniform without moving files between directories, without changing how errors are classified, and without splitting the two oversized modules — those are the three follow-on changes and are explicit non-goals here. Keeping the directory layout fixed means every edit in this change is reviewable as a behavior-preserving transformation plus two small defect fixes.

The `/change` surface must keep working against the legacy Fusion harness, which is registered unconditionally alongside it and owns its own `CUSTOM_TYPE`, widgets, and panels. This change deliberately mirrors Fusion's presentation contract rather than inventing a third one.

## Goals / Non-Goals

**Goals:**

- One place declares what each action accepts and requires.
- One handler shape, so a new phase is a small file with no boilerplate to copy.
- One transcript identity with a renderer and structured details, matching the Fusion contract.
- One model-resolution precedence for every role and phase.
- Configuration separated from test substitution points, with narrow substitution inputs.
- One implementation of each shared helper.
- Correct the two observable defects found during analysis: missing progress on `verify`/`finish`, and the unpopulated actor.

**Non-Goals:**

- Merging `src/muster/` and `src/runtime/` or breaking their import cycle.
- Replacing the error-code-to-blocker classification logic.
- Splitting `change-command.ts` or `implementation.ts`.
- Changing the `/change` grammar, outcome statuses, blocker kinds, lifecycle rules, or any controller gate.
- Changing the legacy Fusion commands.

## Decisions

### 1. Sequence the work as five behavior-preserving steps, helpers first

The order is: shared helpers, then branding, then the metadata table, then the handler contract, then the options split. Helpers first means the later steps delete code rather than move it. Branding before the handler contract means the handler contract can return a structured outcome that already has a place to go. The metadata table before the handler contract means the contract can read its per-action rules from the table rather than take them as constructor arguments.

Each step ends with the full suite at the known baseline, so a regression is attributable to one step.

Alternative considered: rewrite the handlers first, since that is the most visible improvement. Rejected because the handler rewrite would then carry the duplicated helpers into the new shape and have to be revisited.

### 2. Shared helpers get single owners in existing layers, not a new utility module

- Command-line flag reading → `src/shared/`, because both the explore handler and the planning runner need it and neither owns the other.
- Path existence and path containment → `src/shared/`, because three runtime modules and one path-validation routine need them.
- Persisted record reading → `src/persistence/`, next to the store it reads through.
- Validated task-document loading (read `tasks.md`, harvest referenced requirements and scenarios, validate) → `src/execution/`, next to the parser and schema it composes.
- Source-digest reading (head plus diff, then digest) → `src/execution/change-digests.ts`, which already owns the digest functions.
- Change run-store opening (store plus run identity plus manifest read/write) → `src/persistence/`, next to the store and record schemas.

Deliberately not a single `utils.ts`: each helper belongs to a layer that already exists, and a shared grab-bag would immediately attract unrelated code.

### 3. Branding is an exported module, mirroring Fusion's `CUSTOM_TYPE`

A new runtime branding module exports the custom message type, a widget-key derivation function taking a scope string, and a details type derived from the outcome type so the two cannot drift:

```ts
export const MUSTER_CUSTOM_TYPE = "muster-change";
export const musterWidgetKey = (scope: string) => `${MUSTER_CUSTOM_TYPE}-${scope}-${randomUUID()}`;
export type MusterChangeDetails = Pick<CommandOutcome, "action" | "changeName" | "status" | "runId" | "code">;
```

The transcript-posting seam currently accepts a pre-rendered string, which destroys the outcome before the host sees it. It is widened to accept either an outcome or a string: handlers and the dispatcher pass the outcome so details can be attached, while short status and error notices may still pass a string. The renderer registered for the custom type formats the outcome; the plain-text rendering already in use becomes the content field, so hosts without renderers are unaffected. This is the reason the widened seam is not a breaking change for tests, which observe content.

Alternative considered: keep the string seam and attach details out of band. Rejected because the details would have to be recomputed from parsed text.

### 4. Command metadata is one table typed against the action union

```ts
const changeCommands = {
  explore: { args: "free-text",     change: "none",     lifecycleGated: false, runIdentity: "none" },
  propose: { args: "change+text",   change: "optional", lifecycleGated: false, runIdentity: "per-invocation" },
  resume:  { args: "checkpoint-id", change: "required", lifecycleGated: true,  runIdentity: "per-change" },
  ...
} as const satisfies Record<ChangeAction, ChangeCommandSpec>;
```

`satisfies Record<ChangeAction, ...>` makes an action added to the union a compile error until it is declared. The dispatcher's current inline special cases for `explore`, `propose`, `resume`, and `status`, the hardcoded stateful-action list in the assembly, the advertised subcommand list, and the two usage strings are all derived from this table.

`runIdentity` distinguishes the actions that must reuse a stable per-change run identity (so their persisted state is found again) from those that get a fresh identity per invocation. That distinction currently exists as a hardcoded array in the assembly while the affected phases independently recompute the per-change identity, which is why the assembly's computed identity is ignored by exactly those phases.

Lifecycle gating stays delegated to the existing action resolver; the table only records *whether* an action is gated, not the rules.

### 5. Handlers are defined through one factory that normalizes the request

```ts
defineChangeHandler("verify", {
  run: async (req) => runVerification({ cwd: req.cwd, changeName: req.changeName, ... }),
});
```

The factory reads the action's declaration from the metadata table and, before calling `run`:

- enforces the declared change requirement and argument arity, returning a blocked outcome with that action's usage when unsatisfied;
- types `changeName` as a required string when the declaration requires one, removing the seven non-null assertions;
- joins free-text arguments once;
- merges the configuration and host cancellation signals once;
- resolves the agent-run observer once, so a phase cannot silently omit it;
- exposes the change snapshot through a memoized accessor, so a handler that needs it does not repeat the loading expression and a handler that does not need it does not pay for it;
- attaches the action and change name to the returned outcome.

`verify` and `finish` stop taking an ignored context and therefore start forwarding the observer — this is how the missing-progress defect is fixed structurally rather than by two spot edits.

Alternative considered: a base class. Rejected because handlers have no state and a factory returning a closure matches the existing `createXHandler(cwd, options)` call shape used by the assembly, so the assembly does not change.

### 6. The actor comes from the host invocation

The command registration builds the invocation context and currently omits the actor field, so the one consumer always falls back to a placeholder. Registration populates it from the host context where the host supplies an identity, and from an explicit local-user identity otherwise. The normalized request exposes it, and the confirmation path records it. The fallback remains, but it becomes a real default rather than the only reachable value.

### 7. Model resolution is one function with per-role environment overrides

One resolver applies environment override, then configured stack slot, then flag, then declared fallback, for each role. The existing exploration-specific resolver becomes a role lookup against that resolver's result. The two copies of the same fallback model string collapse to one declaration per role. The existing exploration environment variable keeps working; equivalents are added for the other roles so the documented precedence is true for every phase rather than one.

### 8. Options split into configuration and overrides

```ts
interface RuntimeConfig   { cwd?; now?; signal?; argv?; onAgentStart?; }
interface RuntimeOverrides { runners?: {...}; ports?: {...}; }
```

Substitution points take narrow inputs — a state loader receives the change name, working directory, signal, and clock, not the entire configuration including sibling substitution points. Each phase declares its own options type, so the finish phase stops borrowing the verification phase's type.

Per-invocation state construction is reduced to the fields handlers actually read. The analysis found handlers read only the run identity, while change resolution, model-stack resolution, and an output sink are constructed on every invocation — including read-only status — and never read. The run identity moves into the normalized request; the unread construction is removed. If a later change needs resolved models or a resolved change per invocation, it can reintroduce them as consumed fields.

Alternative considered: keep the existing context and make handlers consume its fields. Rejected for now because it would require every phase to be re-plumbed, which is a larger change than removing state nothing reads; the option remains open.

## Risks / Trade-offs

- **Nine handlers change at once in step four.** Mitigated by the four preceding steps being pure deduplication, by handler behavior being covered by the existing dispatcher and outcome tests, and by the factory attaching action and change name so an omission is a type error rather than a silent wrong value.
- **Widening the transcript seam touches a boundary tests assert on.** Mitigated by keeping the rendered content byte-identical and adding details alongside it; tests that read content are unaffected.
- **Adding per-role environment overrides changes model selection for users who set them.** They do not exist today, so no current configuration changes behavior; the fallback and configuration paths are unchanged.
- **Removing unread per-invocation state could be reversed by a later change.** Accepted: reintroducing a field with a consumer is cheaper than carrying five unread fields and the eager resolution they require.

## Migration Plan

Five commits in order, each leaving the suite at the known Windows baseline:

1. Shared helpers extracted; duplicate copies deleted.
2. Branding module, renderer registration, and widened transcript seam.
3. Command metadata table; dispatcher, usage, subcommand list, and run-identity selection derived from it.
4. Handler contract; all nine handlers rewritten; actor populated; `verify`/`finish` observer forwarding restored.
5. Options split; per-phase options types; unread per-invocation state removed.

Steps two through five each depend on the one before it. No step requires a data migration, and no persisted format changes.

## Open Questions

None. The environment-variable naming for the new per-role overrides follows the existing exploration variable's pattern; if the maintainer prefers different names, that is a rename inside step five's resolver and affects nothing else.
