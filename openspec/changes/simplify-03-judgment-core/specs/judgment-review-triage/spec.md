## REMOVED Requirements

### Requirement: Triage is off unless explicitly enabled
**Reason**: Triage no longer has an enabling flag of its own; it runs whenever judgment is enabled.
**Migration**: See "Triage runs whenever judgment is enabled". Operators who set the triage flag can unset it.

## ADDED Requirements

### Requirement: Triage runs whenever judgment is enabled

Triage SHALL run whenever judgment is enabled and SHALL NOT need an enabling flag of its own. When judgment is disabled or unavailable, every changed artifact set SHALL receive a full review exactly as it does without judgment, no snapshot SHALL be retained, and no judgment request SHALL be sent on triage's account.

#### Scenario: Judgment disabled means full review

- **WHEN** judgment is not enabled and a proposal typo is fixed after an approval
- **THEN** a full review is dispatched exactly as without judgment

#### Scenario: Judgment enabled runs triage without another variable

- **WHEN** judgment is enabled and an approved review exists with a retained copy
- **THEN** triage is asked without any further variable being set
