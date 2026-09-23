## ADDED Requirements

### Requirement: The change command is the only registered command

The entry point SHALL register exactly one command, `change`, and no other slash command.

#### Scenario: Registration lists one command

- **WHEN** the entry point registers with a host that records registered commands
- **THEN** the recorded set is exactly `change`

### Requirement: Retired commands are removed rather than aliased

The commands `refine`, `implement`, `ship`, `os-status`, `init` and every command whose name begins with `fh` SHALL NOT be registered, and no code SHALL exist whose only purpose is to print guidance about them.

#### Scenario: A retired command is not registered

- **WHEN** the entry point registers
- **THEN** none of the retired command names is registered

#### Scenario: No migration stub remains

- **WHEN** the source tree is searched for the deprecation guidance strings of the retired commands
- **THEN** none is found

### Requirement: Flags the pipeline reads are registered by the entry point

The entry point SHALL register the flags `fh-config`, `architect`, `builder`, `planning-max-tokens` and `planning-max-cost`, so that the host accepts them on the command line. Each flag SHALL keep its name and its meaning. No flag SHALL be registered that the pipeline does not read.

#### Scenario: A flag is accepted

- **WHEN** the host is launched with `--fh-config` naming a model-stack file
- **THEN** the host accepts the flag and model resolution uses that file

#### Scenario: Unread flags are not registered

- **WHEN** the entry point registers
- **THEN** the registered flags are exactly the five named above
