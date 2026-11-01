# Proposal

## Why

Linux compilation fails because provider profiles use keyring unconditionally but the dependency is declared only for macOS. This blocks the Linux verification gate.

## What Changes

- Declare the existing keyring dependency for every target that compiles the profile code.
- Preserve native credential-store errors and the existing supported release target.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. Profile publication requirements remain unchanged.

## Impact

The native manifest changes. The existing locked keyring version selects its platform store; no credential fallback or gate is added.

The Linux gate also exposed directory synchronization through a path-only descriptor. Open the same confined directory for reading before syncing it so successful file publication remains durable.
