# Proposal

## Why

Native test intermittency needs evidence without turning a failed gate green.

## What Changes

- Compare native Rust tests on macOS on main and daily.
- Keep human PR admission unchanged.

## Capabilities

### New Capabilities

- `rust-test-reliability`: Detect inconsistent native Rust test outcomes.

### Modified Capabilities

None.

## Impact

Adds a macOS reliability workflow, detector, tests, and reproduction guide.
