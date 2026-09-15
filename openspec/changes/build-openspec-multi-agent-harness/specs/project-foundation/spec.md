## Purpose

Defines the supported runtime, repository, packaging, migration, and compatibility contract for the unified muster Pi extension.

## ADDED Requirements

### Requirement: Canonical implementation repository
Muster SHALL contain the complete implementation of the harness and SHALL NOT require the sibling Muster checkout at runtime or during normal development.

#### Scenario: Run without the import source
- **WHEN** muster is installed on a machine that does not contain the sibling Muster repository
- **THEN** the extension loads and all shipped capabilities remain available

### Requirement: Licensed Fusion snapshot import
The imported Fusion source SHALL correspond to commit `51f1d85499a1292cb79036d6ae237db7ea52096e`, SHALL omit imported Git history and source-level attribution headers, and SHALL retain the imported project's MIT notice in `THIRD_PARTY_NOTICES.md`.

#### Scenario: Distribution contains required notice
- **WHEN** a muster source or package distribution contains a substantial portion of imported Fusion code
- **THEN** the distribution includes the Fusion MIT copyright and permission notice in `THIRD_PARTY_NOTICES.md`

### Requirement: Supported runtime baseline
The beta SHALL support Node.js 22, Bun, TypeScript, and ESM on Linux, macOS, and native Windows.

#### Scenario: Platform verification matrix
- **WHEN** the release test workflow runs on each supported operating system with Node.js 22 and the documented Bun version range
- **THEN** type checking, unit tests, integration tests, and extension smoke tests pass

### Requirement: One extension distribution
The project SHALL ship the development harness as one Pi extension with one configuration surface and one command registry.

#### Scenario: Extension discovery
- **WHEN** Pi discovers the installed muster extension
- **THEN** one extension registers the supported Fusion and `/change` commands without requiring a second orchestration extension

### Requirement: Incremental compatibility migration
Existing `/fh-*`, `/refine`, `/implement`, and `/ship` commands SHALL remain available during the beta and SHALL display migration guidance when an equivalent `/change` command exists.

#### Scenario: Legacy workflow invocation
- **WHEN** a user invokes a preserved legacy workflow command
- **THEN** the command still performs its supported behavior and identifies the preferred `/change` equivalent

### Requirement: Correctness-ready beta labeling
The initial release SHALL identify itself as a correctness-ready beta and SHALL NOT advertise a verified token-reduction percentage until comparative evidence exists.

#### Scenario: Version and help output
- **WHEN** a user inspects version, help, or release documentation
- **THEN** the release status and unverified optimization hypothesis are represented accurately