# Spec Delta

## Purpose

Expose native provider sign-in and account management through the intended host permission boundary.

## ADDED Requirements

### Requirement: Registered provider auth commands have matching host permissions
Provider authentication status, start, cancel, and logout commands MUST be available to the main host frame through matching native command declarations and ACL entries, while sandboxed panels MUST remain unable to invoke them.

#### Scenario: The host starts provider sign-in
- **WHEN** the main host frame invokes a registered provider auth command
- **THEN** its ACL permits the command

#### Scenario: A sandboxed panel requests provider sign-in
- **WHEN** a sandboxed panel attempts the same native invocation
- **THEN** the host permission boundary denies it
