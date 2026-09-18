## Purpose

Defines the layering contract for the `/change` command surface: which kinds of module exist, what each may contain, and the permitted direction of dependencies between them.

## ADDED Requirements

### Requirement: Two-layer command surface

The `/change` command surface SHALL be organized into exactly two layers: a handler layer containing one module per advertised action, and a phase layer containing the phase runners those handlers invoke. A handler module SHALL contain only argument interpretation and the invocation of one phase; it SHALL NOT contain phase logic. A phase runner SHALL live in the phase layer regardless of how many actions invoke it.

#### Scenario: Phase is used by one action

- **WHEN** a phase runner is invoked by exactly one action
- **THEN** it resides in the phase layer, not inside that action's handler module

#### Scenario: Phase gains a second consumer

- **WHEN** a second action begins invoking an existing phase runner
- **THEN** no module is relocated, because placement does not depend on the number of consumers

#### Scenario: Handler module is inspected

- **WHEN** a handler module is read
- **THEN** it interprets the invocation's arguments and delegates to one phase, and contains no artifact parsing, agent orchestration, persistence, or version-control work

### Requirement: One-directional layer dependencies

The handler layer SHALL depend on the phase layer and the shared command surface modules. The phase layer SHALL NOT depend on the handler layer. Shared command surface types SHALL NOT depend on handler modules. The command surface SHALL contain no cycle between its layers.

#### Scenario: Phase declares the options it accepts

- **WHEN** a phase runner declares its options type
- **THEN** that type is owned by the phase layer and is referenced by handlers and shared types without either importing a handler module

#### Scenario: Dependency direction is checked

- **WHEN** the command surface's module dependencies are inspected
- **THEN** no import path leads from the phase layer or the shared command types back into the handler layer

### Requirement: Stable extension entry point

The module registered as the extension entry point SHALL keep its existing external path and exported registration signature across this reorganization, so the packaged extension manifest and any external consumer are unaffected.

#### Scenario: Extension is installed after the reorganization

- **WHEN** the extension is loaded through its declared manifest entry
- **THEN** registration succeeds and every advertised `/change` action is available, with no manifest change required

### Requirement: Documented paths match the source layout

Repository guidance that names command surface paths — agent guidelines, wiring instructions, and roadmap or design references — SHALL name paths that exist in the source tree.

#### Scenario: Guidance is consulted after a move

- **WHEN** a contributor follows repository guidance to locate a command surface module
- **THEN** the named path exists

#### Scenario: Stale path remains

- **WHEN** a documented path no longer exists after modules are moved
- **THEN** that is a defect to be corrected in the same change that moved them
