## ADDED Requirements

### Requirement: Detect inconsistent native Rust test outcomes

The system SHALL compare independent native Rust test runs without hiding a
failure and SHALL report incomplete evidence as a failed check.

#### Scenario: A test has mixed outcomes

- **WHEN** complete structured runs report both a pass and failure for a test
- **THEN** the workflow names that test and fails

#### Scenario: Evidence is missing

- **WHEN** a report or test outcome is incomplete
- **THEN** the workflow fails without classifying the missing outcome as a pass
