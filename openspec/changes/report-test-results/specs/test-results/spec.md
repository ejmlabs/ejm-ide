## ADDED Requirements

### Requirement: Machine-readable test results

When `EJM_TEST_REPORT` names a report file, the Vitest suite SHALL write test-level results to that file and preserve normal console output and exit status.

#### Scenario: Successful or failing test run

- **WHEN** the test suite runs with `EJM_TEST_REPORT` set
- **THEN** the run writes a JSON report and keeps the original test status

#### Scenario: Local default

- **WHEN** `EJM_TEST_REPORT` is unset
- **THEN** the suite uses its usual console reporter

### Requirement: Repeated frontend evidence

The reliability workflow SHALL collect the existing frontend suite and compare two independent runs, preserving both exit statuses and full test identities. Missing, skipped, ambiguous, or incomplete evidence SHALL fail the workflow.

#### Scenario: First attempt fails

- **WHEN** the first attempt fails and the second passes
- **THEN** the workflow fails and reports tests with mixed outcomes

#### Scenario: Evidence is incomplete

- **WHEN** a collected test is omitted or a test is skipped in either attempt
- **THEN** the workflow fails while reporting other unambiguous mixed outcomes
