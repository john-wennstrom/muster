## REMOVED Requirements

### Requirement: Routing is opt-in and inert without an economy lane
**Reason**: Routing no longer has an enabling flag of its own; it needs judgment and a configured economy model.
**Migration**: See "Routing is inert without an economy lane". Operators who set the routing flag can unset it.

## ADDED Requirements

### Requirement: Routing is inert without an economy lane

Task routing SHALL run only when judgment is enabled and an economy model is configured, and SHALL NOT need an enabling flag of its own. Without either, every builder task SHALL use the primary builder exactly as it does without judgment, and no request SHALL be sent on routing's account.

#### Scenario: No economy model means no routing

- **WHEN** judgment is enabled but no economy model is configured
- **THEN** every task uses the primary builder and no routing request is sent

#### Scenario: Judgment disabled means no routing

- **WHEN** an economy model is configured and judgment is not enabled
- **THEN** every task uses the primary builder and no routing request is sent

#### Scenario: Both present means routing is asked

- **WHEN** judgment is enabled and an economy model is configured
- **THEN** each task's first attempt is asked for a routing judgment without any further variable being set
