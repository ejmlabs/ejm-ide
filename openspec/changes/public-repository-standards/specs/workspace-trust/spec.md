# Spec Delta

## Purpose

Let users inspect and edit unfamiliar workspaces before enabling project tooling that can execute local code.

## ADDED Requirements

### Requirement: Automatic project execution requires trust
Newly opened workspaces MUST remain untrusted until the user explicitly trusts the selected canonical root. Automatic language servers and project format or lint tools MUST refuse execution before that decision. A different workspace MUST require a new decision.

#### Scenario: An unfamiliar workspace opens
- **WHEN** a user opens or edits files without granting workspace trust
- **THEN** editing and browsing work while language servers and project quality processes remain stopped

#### Scenario: The user grants trust
- **WHEN** the user confirms trust for the current canonical workspace root
- **THEN** automatic language and quality tooling can run for that workspace

#### Scenario: A stale trust request arrives
- **WHEN** the requested root differs from the selected workspace
- **THEN** the host refuses to grant trust
