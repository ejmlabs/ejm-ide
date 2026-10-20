# Proposal

## Why

Security audit finding **M1** (`security-baseline-2026-10-19.md`, ejm-ide at `0309cb7`) blocks the 0.1.0 release. Today a second AI model, not a person, approves every agent file write (`src-tauri/src/agent.rs:51-60` `REVIEW_INSTRUCTIONS`; `agent.rs:768-862` `reviewed_write()` applies the edit as soon as the reviewer returns `approved: true`). The only path the agent cannot write is Git metadata (`src-tauri/src/workspace.rs:265-278` `agent_file_root()`; `agent_tools.rs:480-505` `file_path()`).

Both models read untrusted repo content. A prompt injection could get both to accept an edit to `build.rs`, `Cargo.toml` or another build config. In a trusted workspace, saving any `.rs` file then runs `quality_lint` (`app/App.tsx:1230-1246`), which maps `.rs` to `cargo clippy` (`src-tauri/src/quality.rs:105,187`). Clippy compiles and runs `build.rs` and proc macros, so the injected code runs as the user and no person ever approved the change. The instruction to treat content as untrusted is a soft control. It does not stop this.

## What Changes

- **BREAKING (agent UX):** an agent write to a **sensitive path** applies only after a person explicitly confirms that exact write in the IDE. AI reviewer approval alone never applies it. The AI reviewer can still deny a write before the person is asked.
- Denial, timeout, cancellation, a workspace switch, or a changed file version means nothing is written. A denial is reported to the agent as a failed action, the same way an AI-reviewer denial is reported today.
- Sensitive paths are matched on the normalized, workspace-relative target path, at any depth, ignoring ASCII case and Unicode normalization differences. Parent traversal and symbolic links stay rejected, as they are today.
- Every kind of agent mutation counts: create, replace, and any rename, move or delete tool added later (none is registered today).
- Git metadata (`.git` in any case) stays blocked, even when a person confirms.
- Under the recommended Option A, non-sensitive writes keep today's AI-reviewed flow.

### Decision for Everett: Option A (recommended) vs Option B

**Option A (recommended for 0.1.0): human confirmation for sensitive paths only.** The delta specs in this change are written for Option A. The sensitive set is:

`build.rs`, `Cargo.toml`, `.cargo/**`, `package.json`, `*.config.*`, `pyproject.toml`, `setup.py`, `Makefile`, `.github/**`, `.workbench/**`, `.vscode/**`, `scripts/**`

This is the brief's list plus `pyproject.toml`, `setup.py`, `Makefile` and `.vscode/**`, which the audit names under "at minimum". See Open Questions.

- Pros: closes the M1 code-execution path. Routine source edits keep their current speed. The change is small enough to land before 0.1.0.
- Cons: protection depends on keeping a denylist up to date. Any execution-relevant file left off the list keeps the M1 weakness (see Open Questions for candidates). Ordinary source files are still approved only by the AI. A later save or build can still run them (for example a test or a proc-macro crate), just less directly.

**Option B: human review becomes the default for every agent write.** The AI reviewer becomes an opt-in convenience, and even then it applies only to non-sensitive paths.

- Pros: this is the audit's "better still" option. It needs no list to be complete, and every byte the agent writes is something a person saw.
- Cons: much more friction, with one prompt per write in multi-file edits. It needs larger UX work (batching, diff review) and possibly a setting with persistence. That puts more risk on the 0.1.0 date.
- Spec impact if chosen: every requirement below stays. Only **Non-sensitive writes keep the current review flow** is replaced, by "agent writes require human confirmation by default; the AI reviewer MAY approve non-sensitive writes only when the user has opted in". Option B therefore builds on Option A, so A can ship now and B can follow.

### Out of scope

- Sandboxing `cargo clippy`, language servers or other quality tools, and suspending auto-lint for agent-changed files. The audit suggests the latter as an extra hardening step; it is a candidate follow-up.
- Changes to the trusted-workspace model (owned by the `workspace-trust` capability in the in-flight `public-repository-standards` change).
- Adding new agent tools (shell, delete, rename), or "always allow" / remembered approvals.
- Writes the user makes in the editor. This change governs only agent-initiated writes.
- Other audit findings (L1, L3, L4).

## Capabilities

### New Capabilities

- `agent-write-approval`: which agent file writes need a person's explicit confirmation, how sensitive paths are recognized, and what happens on denial or timeout.

### Modified Capabilities

None. `openspec/specs/` in ejm-ide has no main specs (only `.gitkeep`). The related `workspace-trust` capability exists only in the unarchived `public-repository-standards` change, and this change does not alter it.

## Impact

- Native: `src-tauri/src/agent.rs` (`reviewed_write`, review instructions/events), `src-tauri/src/agent_tools.rs` (`PreparedWrite`, path normalization), `src-tauri/src/workspace.rs` (`agent_file_root`, `apply_agent_write`).
- Frontend: a new human confirmation surface in the agent pane that shows the path and diff, with Approve/Deny. It plugs into the existing `item/autoApprovalReview/*` event flow. Unused `.approval-request` styles already exist in `app/styles.css:1837`.
- Tests: native unit tests for classification (case, Unicode, nesting, `./`, absolute paths) and for denial, timeout and cancellation. Frontend tests for the confirmation UI.
- Agent prompts: `INSTRUCTIONS` currently says "ejm-ide automatically reviews every proposed write". It needs to say that some writes wait for the user.
- No change to provider, Git or quality-tool code.

## Open Questions

1. **Option A or Option B?** (Everett.) Recommendation: A for 0.1.0, with B considered after.
2. **Final sensitive list.** The brief's list leaves out `pyproject.toml`, `setup.py`, `Makefile` and `.vscode/**`, but the audit lists them as a minimum. The draft includes them. Should they stay?
3. **More files the IDE or its tools execute that neither list covers.** Recommendation: add them.
   - `rust-toolchain` / `rust-toolchain.toml`: rustup honors a toolchain `path`, so the next `cargo clippy` can run a different binary.
   - `Gemfile`, `*.gemspec` and `.rubocop.yml`: RuboCop is an auto-lint tool here (`quality.rs:97-106`), and its `require:` loads Ruby code. `ruby-lsp` loads the Gemfile.
   - `.envrc`, `go.mod` (its `toolchain` directive), `biome.json(c)`: lower priority.
4. **Depth of directory patterns.** The draft treats `.cargo/`, `.github/`, `.workbench/`, `.vscode/` and `scripts/` as sensitive at any depth. Cargo reads `.cargo/config.toml` from every ancestor directory, and monorepos nest packages. The cost is extra prompts for something like `src/scripts/`. Is that acceptable?
5. **Confirmation timeout length.** The draft requires a bounded wait with no auto-approval. Suggested: 120 s, matching the existing `approvalTimeoutMs` shown in the Debug pane (`app/lib/harness.ts:290`), versus waiting until the turn is cancelled.
6. **Should the AI reviewer still run before the human prompt for sensitive paths?** The draft keeps it as a pre-filter that can only deny. The alternative skips it so the person always decides.
