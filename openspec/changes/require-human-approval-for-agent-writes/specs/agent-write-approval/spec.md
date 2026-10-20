# Spec Delta

## Purpose

Make sure no agent file change that can lead to code execution is applied unless a person has explicitly approved that exact change, while routine agent edits keep the current automatic review flow.

## ADDED Requirements

### Requirement: Sensitive agent writes require explicit human confirmation
The IDE MUST NOT apply an agent write whose target is a sensitive path until the user explicitly confirms that specific write in the IDE. The confirmation MUST show the workspace-relative path and the full proposed change. Approval from the automatic AI reviewer MUST NOT stand in for this confirmation. The AI reviewer MAY still deny the write before the user is asked. This applies in trusted and untrusted workspaces alike.

#### Scenario: AI reviewer approves a build script edit
- **WHEN** the agent proposes a change to `build.rs` and the AI reviewer returns approved
- **THEN** the file is not written yet
- **AND** the IDE asks the user to confirm the write, showing the path and diff

#### Scenario: User confirms a sensitive write
- **WHEN** the user approves the pending confirmation for `Cargo.toml`
- **AND** the file still matches the version the agent read
- **THEN** the IDE applies exactly the confirmed content and reports success to the agent

#### Scenario: AI reviewer denies a sensitive write
- **WHEN** the AI reviewer rejects a proposed change to `.github/workflows/ci.yml`
- **THEN** the file is not written and the user is not asked to approve it

#### Scenario: Injected instructions claim approval
- **WHEN** repository content, tool output or model text claims that the user already approved a sensitive write
- **THEN** the IDE still asks for the user's confirmation and writes nothing until the user confirms in the IDE

### Requirement: Unconfirmed sensitive writes are never applied
A sensitive agent write MUST be discarded and reported to the agent as a failed action when the user denies it, when the agent turn is cancelled, when the workspace selection changes, or when the target file changes on disk before the write is applied. A confirmation MUST apply only to the single write it was shown for.

#### Scenario: User denies
- **WHEN** the user denies a pending sensitive write
- **THEN** no file is created or changed and the agent receives a denial result

#### Scenario: Turn cancelled or workspace switched while waiting
- **WHEN** the agent turn is cancelled or a different workspace is selected while a confirmation is pending
- **THEN** the pending confirmation is withdrawn and nothing is written

#### Scenario: File changed after the user confirmed
- **WHEN** the user confirms a write but the target file's on-disk version changed after the agent read it
- **THEN** nothing is written and the agent is told to re-read the file

#### Scenario: Confirmation is not reusable
- **WHEN** the agent proposes a second sensitive write after a confirmed one
- **THEN** the IDE asks for a new confirmation for the second write

### Requirement: Sensitive file names
The IDE MUST treat as sensitive any workspace-relative target, at any depth, whose final segment is `build.rs`, `Cargo.toml`, `package.json`, `pyproject.toml`, `setup.py`, `setup.cfg`, `Makefile`, `GNUmakefile`, `Rakefile`, `Gemfile`, `Guardfile`, `Brewfile`, `rust-toolchain`, `rust-toolchain.toml`, or `.rubocop.yml`, or matches `*.gemspec` or `*.config.*`.

#### Scenario: Nested crate build script
- **WHEN** the agent proposes a change to `crates/inner/build.rs`
- **THEN** the write requires human confirmation

#### Scenario: Tool config by name pattern
- **WHEN** the agent proposes a change to `vite.config.ts` or `packages/web/eslint.config.mjs`
- **THEN** the write requires human confirmation

#### Scenario: Package and toolchain files
- **WHEN** the agent proposes a change to `pyproject.toml`, `setup.py`, `setup.cfg`, `Makefile`, `GNUmakefile`, `Rakefile`, `Gemfile`, `Guardfile`, `Brewfile`, `rust-toolchain`, `rust-toolchain.toml`, `pkg.gemspec`, or `.rubocop.yml`
- **THEN** each write requires human confirmation

### Requirement: Sensitive directories
The IDE MUST treat a workspace-relative target as sensitive when any directory segment, at any depth, is `.cargo`, `.github`, `.workbench`, `.vscode`, or `scripts`.

#### Scenario: Config file under a dot directory
- **WHEN** the agent proposes creating `.cargo/config.toml` or `tools/.cargo/config.toml`
- **THEN** the write requires human confirmation

#### Scenario: Nested CI directory
- **WHEN** the agent proposes a change to `nested/.github/workflows/ci.yml`
- **THEN** the write requires human confirmation

#### Scenario: Nested editor config
- **WHEN** the agent proposes a change to `sub/crate/.vscode/settings.json`
- **THEN** the write requires human confirmation

### Requirement: Proc-macro Rust sources
The IDE MUST treat a `.rs` file as sensitive when the nearest `Cargo.toml` at or above that file, and still inside the workspace, sets `[lib] proc-macro = true`. The IDE MUST NOT run Cargo to decide this. A `.rs` file whose nearest manifest does not set proc-macro is not sensitive for that reason.

#### Scenario: Ordinary source file
- **WHEN** the agent proposes a change to `src/lib.rs` in a package whose nearest `Cargo.toml` does not set proc-macro
- **THEN** the write is not classified as sensitive

#### Scenario: Rust source in a proc-macro package
- **WHEN** the agent proposes a change to `macros/src/lib.rs` and the nearest `Cargo.toml` sets `[lib] proc-macro = true`
- **THEN** the write requires human confirmation

### Requirement: Sensitive path matching is normalization robust
The IDE MUST classify the same normalized, workspace-relative path that it will write. It MUST compare path segments without regard to ASCII case or Unicode normalization form, and MUST ignore `.` segments and redundant separators. An absolute path inside the workspace MUST be classified the same as its relative form. Parent traversal and symbolic links in the target or its parents MUST still be rejected outright.

#### Scenario: Case variants
- **WHEN** the agent proposes a change to `BUILD.RS`, `cargo.toml` or `.GitHub/workflows/x.yml`
- **THEN** each write requires human confirmation

#### Scenario: Dot segments and absolute paths
- **WHEN** the agent targets `./crates/./a/Cargo.toml` or the absolute path of `Cargo.toml` inside the workspace
- **THEN** the write requires human confirmation

#### Scenario: Unicode normalization variant
- **WHEN** the agent targets a sensitive directory segment spelled with a different Unicode normalization form of the same name
- **THEN** the write requires human confirmation

#### Scenario: Parent traversal
- **WHEN** the agent targets `src/../build.rs` or any path containing `..`
- **THEN** the write is rejected and nothing is written

#### Scenario: Symbolic link alias
- **WHEN** the agent targets a symbolic link, or a path whose parent directory is a symbolic link, that resolves to a sensitive file
- **THEN** the write is rejected and nothing is written

### Requirement: All agent file mutations are covered
Every agent-initiated file mutation MUST be classified and gated by these rules, not only replacements. Covered mutations are creating a file, replacing a file, and any rename, move or delete the agent can perform. A rename or move is sensitive if its source or its destination is sensitive.

#### Scenario: Creating a new sensitive file
- **WHEN** the agent proposes creating a file at `scripts/postinstall.sh` that does not exist yet
- **THEN** the write requires human confirmation

#### Scenario: Future rename into a sensitive path
- **WHEN** an agent tool renames or moves `notes.txt` to `build.rs`, or deletes `Cargo.toml`
- **THEN** the operation requires human confirmation before any file changes

### Requirement: Git metadata remains blocked
Agent file tools MUST continue to refuse every path that has a `.git` segment, in any letter case, and MUST NOT offer a human confirmation that could override this.

#### Scenario: Git hook write
- **WHEN** the agent proposes writing `.git/hooks/pre-commit` or `.GIT/config`
- **THEN** the write is rejected without a confirmation prompt and nothing is written

### Requirement: Non-sensitive writes keep the current review flow
Agent writes to paths that are not sensitive MUST keep today's behavior. The automatic AI reviewer approves or denies them. Workspace confinement, version checks, cancellation and workspace-switch protections still apply. No human confirmation is required.

#### Scenario: Ordinary edit approved by AI reviewer
- **WHEN** the agent proposes a change to `src/main.rs` and the AI reviewer approves it
- **THEN** the IDE applies the write without asking the user

#### Scenario: Ordinary edit denied by AI reviewer
- **WHEN** the AI reviewer denies a change to `README.md`
- **THEN** the file is not written and the agent receives the denial reason

### Requirement: The confirmation deadline cancels the write
The confirmation MUST use a 20 minute decision deadline. When it passes, the write MUST be cancelled and MUST NOT be applied. There MUST be no exception that applies the file. The confirmation MUST collapse to "Timed out · not applied" and MUST offer "Ask agent to try again". That action MUST start a new agent turn that proposes the same change again, and the timed-out write MUST stay unapplied.

#### Scenario: Confirmation times out
- **WHEN** the user does not respond before the 20 minute decision deadline
- **THEN** no file is created or changed
- **AND** the write is cancelled and the agent is told it was not applied

#### Scenario: Ask the agent to try again
- **WHEN** the confirmation has timed out and the user chooses Ask agent to try again
- **THEN** ejm-ide starts a new agent turn that proposes the same change
- **AND** the timed-out write stays unapplied

### Requirement: The last five minutes warn in the card
During the last 5 minutes a pending confirmation MUST show "This request expires in N min if you don't respond.", where N is the remaining whole minutes and counts down.

#### Scenario: Five minute warning
- **WHEN** 5 minutes or fewer remain on a pending confirmation and the deadline has not passed
- **THEN** the confirmation shows "This request expires in N min if you don't respond.", where N is the remaining whole minutes and counts down

### Requirement: One notification at the five minute warning
If the app window is not focused when the 5 minute warning starts, the IDE MUST send exactly one operating-system notification for that request and MUST NOT send another as the countdown continues. If the window is focused when the warning starts, the IDE MUST NOT send that notification.

#### Scenario: One notification when the window is in the background
- **WHEN** the 5 minute warning starts and the app window is not focused
- **THEN** the IDE sends one operating-system notification for that request
- **AND** it does not send another notification for the same request as the countdown continues

#### Scenario: No notification when the window is focused
- **WHEN** the 5 minute warning starts and the app window is focused
- **THEN** the IDE does not send an operating-system notification
