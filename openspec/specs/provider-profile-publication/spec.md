# provider-profile-publication Specification

## Purpose

Keep saved provider profiles usable by ordering profile publication and retirement of their Keychain credentials, including failure and uncertain durability.

## Requirements

### Requirement: Credential retirement follows durable profile publication

The IDE SHALL retain the prior credential until the replacement profile has been written, file-synced, replaced and directory-synced on a supported native target. Successful retirement SHALL preserve the credential referenced by the published profile.

#### Scenario: Successful replacement

- **WHEN** a provider profile is saved with a replacement API key and directory synchronization succeeds
- **THEN** the published profile references the new saved key
- **AND** the prior key is retired only after directory synchronization succeeds

### Requirement: Failure before publication preserves the prior profile

When publication fails before replacement, the IDE SHALL report failure, preserve the prior profile and credential, and remove only a newly staged credential. It SHALL report a staged-credential cleanup failure if that cleanup also fails.

#### Scenario: Replacement cannot publish the staged file

- **WHEN** staging, writing, file synchronization or file replacement fails before a new profile becomes visible
- **THEN** the prior profile state and credential remain available
- **AND** the staged new credential is removed or a cleanup error is reported

### Requirement: Uncertain publication preserves usable credentials

When replacement succeeds but directory synchronization fails, the IDE SHALL report that saved state changed and durability is uncertain. It SHALL preserve the new referenced credential and the prior credential. Clearing or removing a profile under that outcome SHALL retain its prior credential.

#### Scenario: Directory synchronization fails after replacement

- **WHEN** the new profile is visible but the directory synchronization step fails
- **THEN** the IDE reports the changed saved state and directs the user to reload provider configuration
- **AND** both the new and prior credentials remain available

#### Scenario: Clearing or removing a profile has uncertain durability

- **WHEN** a profile clear or removal becomes visible but directory synchronization fails
- **THEN** the IDE reports uncertain durability
- **AND** it preserves the prior credential in case the earlier profile state is restored

### Requirement: Unsupported durability is reported honestly

The IDE SHALL NOT report durable profile publication when the target cannot perform the required directory synchronization. It SHALL retain credentials and report the uncertain outcome without expanding its supported native platforms.

#### Scenario: The target does not support directory synchronization

- **WHEN** the profile has been replaced on a target without the required directory-sync operation
- **THEN** the result reports uncertain durability
- **AND** no prior or newly referenced credential is retired
