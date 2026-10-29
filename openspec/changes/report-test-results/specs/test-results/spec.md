## ADDED Requirements

### Requirement: Machine-readable test results

When `EJM_TEST_REPORT` names a report file, the Vitest suite SHALL write test-level results to that file and preserve normal console output and exit status.

#### Scenario: Successful or failing test run

- **WHEN** the test suite runs with `EJM_TEST_REPORT` set
- **THEN** the run writes a JSON report and keeps the original test status

#### Scenario: Local default

- **WHEN** `EJM_TEST_REPORT` is unset
- **THEN** the suite uses its usual console reporter
