# Design

## Context

Provider profiles call keyring for saved credentials on every target. The existing version supplies native stores by default, including Secret Service on Linux and Credential Manager on Windows.

## Goals / Non-Goals

Make native compilation match those calls without changing credential handling or claiming support for additional release targets.

## Decisions

Move the existing dependency to common dependencies. Gating its callers would require an unsupported-platform credential path and would change their behavior. The existing native backend reports errors instead of storing secrets in plaintext.

## Risks / Trade-offs

- Linux and Windows runtime credential access is not covered by the Linux build gate. The release target remains macOS on Apple Silicon.

The workspace directory handle may be path-only on Linux, so cloning it cannot make it syncable. Open `.` relative to that confined handle for reading and sync that descriptor after publication. Keep errors visible. Existing reviewed-write tests exercise both create and update.
