## ADDED Requirements

### Requirement: The toolbar filters items

The toolbar SHALL filter the visible items by the text typed into the search box.

#### Scenario: Typing filters the list

- **WHEN** the user types `bo` into the search box
- **THEN** only items containing `bo` are shown

#### Scenario: Clearing the box restores the list

- **WHEN** the user clears the search box
- **THEN** every item is shown again