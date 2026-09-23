## ADDED Requirements

### Requirement: Every source module has a production importer or is a declared entry point

Every module under the source tree SHALL be imported by at least one non-test module, or be named in a short declared list of entry points. An automated test SHALL fail when a module satisfies neither condition. A module that is known to be unwired while a later planned change removes or connects it MAY appear in a temporary allowlist that names the responsible change, and an entry SHALL NOT be added to that allowlist for any other reason.

#### Scenario: A module with only test importers fails the guard

- **WHEN** a source module is imported only by tests and is not a declared entry point or an allowlisted module
- **THEN** the guard test fails and names the module

#### Scenario: A declared entry point passes

- **WHEN** a module has no importer because the host or a child process loads it by path and it is listed as an entry point
- **THEN** the guard test passes

#### Scenario: The allowlist names its owner

- **WHEN** the guard test reads the temporary allowlist
- **THEN** every entry names the change that will remove or connect the module

### Requirement: Modules without a production caller are deleted

The capability model router, the state precedence resolver, the manual-checkpoint UI and the telemetry report generator SHALL NOT exist in the source tree, and neither SHALL their tests.

#### Scenario: The four modules are gone

- **WHEN** the source tree is listed
- **THEN** none of the four modules is present
