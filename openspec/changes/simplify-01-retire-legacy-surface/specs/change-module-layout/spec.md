## MODIFIED Requirements

### Requirement: Stable extension entry point

The module registered as the extension entry point SHALL keep its existing external path and exported registration signature, so the packaged extension manifest and any external consumer are unaffected. It SHALL register the `/change` command and the flags that command reads, and nothing else.

#### Scenario: Extension is installed after the reorganization

- **WHEN** the extension is loaded through its declared manifest entry
- **THEN** registration succeeds and every advertised `/change` action is available, with no manifest change required

#### Scenario: Only the change surface is registered

- **WHEN** the entry point registers
- **THEN** the registered commands are exactly `change`, and no code from a retired extension is loaded
