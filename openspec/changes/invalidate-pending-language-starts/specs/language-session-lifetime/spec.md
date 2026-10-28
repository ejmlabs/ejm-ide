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

### Requirement: Workspace changes invalidate frontend startup results

The IDE SHALL apply a language startup's status and capabilities only to the
workspace session that requested it. Matching root and file paths SHALL NOT
make an earlier workspace session current again.

#### Scenario: Old status returns after reopening the same folder

- **WHEN** the user leaves and reopens the same folder while startup is pending
- **AND** the earlier request returns after the reopened file is untrusted or starting
- **THEN** the current file keeps its current session's status and capabilities

#### Scenario: Old request rejects after reopening the same folder

- **WHEN** an earlier workspace's startup rejects after the same file is reopened
- **THEN** the earlier error does not replace the current session's status or capabilities

#### Scenario: Current startup completes

- **WHEN** startup completes for the current workspace and an open file
- **THEN** its returned status and capabilities remain eligible for presentation
