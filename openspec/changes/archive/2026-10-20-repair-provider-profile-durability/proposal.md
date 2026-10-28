# Proposal

## Why

The protected IDE syncs new provider config bytes and renames the file, then deletes the prior Keychain credential without syncing the containing directory. A crash can expose the prior profile after its key was deleted; adding directory sync also requires distinguishing an uncertain published write from failure before publication.

## What Changes

- Sync the provider config directory after replacing the profile file.
- Keep both old and new credentials when replacement is visible but directory sync fails.
- Delete a staged credential only when profile publication failed before replacement.
- Retire prior credentials only after confirmed directory sync, including profile clear and removal.
- Use the existing locked tempfile package for staging, with a private path writer and final directory-sync test port.
- Upgrade overlapping fixtures and add at most four distinct regression cases.
- Document recovery, retained-key limits and the verified native scope.

## Capabilities

### New Capabilities

- `provider-profile-publication`: Safe publication of provider profiles and ordered retirement of their Keychain credentials.

### Modified Capabilities

None.

## Impact

The IDE owns this adapter. Expected edits are `src-tauri/src/providers/profiles.rs`, moving the existing tempfile dependency in `src-tauri/Cargo.toml`, `docs/harness.md`, `CHANGELOG.md`, and this change. Keep the existing Keychain adapter and service IDs, credential file format, IPC, Cargo lock and immutable harness pin `09b779ee0452dda07b7f52503be22e65fe238373` fixed.

Dependencies remain IDE to public harness APIs. No harness, CLI, shared UI, auth migration or Agent Scale source is imported. The supported target remains macOS on Apple Silicon; unsupported directory sync must report uncertain durability rather than claim success. The static public overview has no affected durability claim or authored docs routes at this base, so it needs review but no planned source change.

This proposal is based on protected main `0309cb7aceae91034d710ee3dbe992edd9a9df31`. Implementation and native gates require root review and a separate release of the resource budget. No publication is included.
