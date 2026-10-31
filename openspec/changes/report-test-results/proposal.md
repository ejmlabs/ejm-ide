# Proposal

## Why

The shared CI gate needs test-level outcomes to identify inconsistent tests across runs.

## What Changes

- Allow CI to request a Vitest JSON report while preserving the normal reporter and test exit status.
- Give parameterized cases distinct names so their individual outcomes are identifiable.

## Capabilities

### New Capabilities

- `test-results`: Machine-readable outcomes for the existing Vitest suite.

### Modified Capabilities

None.

## Impact

The Vitest configuration and two parameterized test tables change. Product behavior and native Rust tests are unchanged.
