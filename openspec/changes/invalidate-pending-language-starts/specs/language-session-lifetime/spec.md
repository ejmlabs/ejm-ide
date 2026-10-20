# Spec Delta

## Purpose

Keep language services tied to the workspace session that requested them,
including starts that finish after the user changes folders.

## ADDED Requirements

### Requirement: Workspace changes invalidate pending server publication

The IDE SHALL reject a pending language-server start when the workspace session
changes before that start is retained. The rejected start SHALL release its
owned client through normal cleanup.

#### Scenario: Switch folders during initialization

- **WHEN** a language server is initializing and the user opens another folder
- **THEN** the earlier start is not retained as an active language service
- **AND** its owned client is released after initialization returns

#### Scenario: Reopen the same folder

- **WHEN** the user switches away and back while an earlier start is pending
- **THEN** matching root text does not revive the earlier start
- **AND** a start for the current workspace session can proceed

#### Scenario: Start within the current workspace session

- **WHEN** the workspace session stays unchanged during language-server startup
- **THEN** that startup remains eligible to become the active language service
