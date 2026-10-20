# Tasks

This change implements the Option A specs. Do not implement Option B, and do not change quality-tool code. Tests are part of each task. No paid model calls.

## 1. Sensitive-path gate

- [ ] 1.1 Classify the normalized workspace-relative path after dropping `.` segments, accepting an absolute path inside the workspace, and comparing segments with NFKC plus ASCII case-folding. Require confirmation for `crates/inner/build.rs`, `.cargo/config.toml`, `tools/.cargo/config.toml`, `vite.config.ts`, `packages/web/eslint.config.mjs`, `BUILD.RS`, `cargo.toml`, `.GitHub/workflows/x.yml`, `./crates/./a/Cargo.toml`, the absolute path of workspace `Cargo.toml`, a fullwidth spelling of `scripts`, and a new `scripts/postinstall.sh`. Do not classify `src/lib.rs`. Test each of those cases.
- [ ] 1.2 Reject `src/../build.rs` and any path containing `..` with no confirmation and no write. Reject a symbolic link, and a parent that is a symbolic link, the same way, including when the link would resolve to a sensitive file. Test both.
- [ ] 1.3 Keep `.git` blocked in any case, with no confirmation. Test `.git/hooks/pre-commit` and `.GIT/config`. Expose the same classifier for a future rename or move (sensitive if the source or the destination is) and for a future delete. Test a rename of `notes.txt` to `build.rs` and a delete of `Cargo.toml`. Do not register a rename, move, or delete tool, and keep the existing registry test that those names are absent.
- [ ] 1.4 Add an in-memory single-use confirmation (review id, oneshot, prepared write, turn, workspace) and `agent_write_decision` with the host token and main-window check. Register it in `src-tauri/build.rs`, the invoke handler, and the generated ACL, and keep the command-parity test passing. Prove `agent_ide_ack` does not resolve it, a second decision fails, a bad token or window fails, and file text or review text that claims the user already approved does not.
- [ ] 1.5 Pause inside `reviewed_write` for a sensitive path only after a valid reviewer approval, for at most 120 seconds, without using the 30 second presentation timeout. Publish `item/autoApprovalReview/awaitingUser` with the path and the full before/after, and do not publish `completed`/`approved` until the person confirms. On confirm, re-check the version and apply that exact content. Test: reviewer approval of `build.rs` writes nothing until confirm; confirming `Cargo.toml` while the version matches reports success; a second sensitive write asks again; reviewer rejection of `.github/workflows/ci.yml` writes nothing and does not ask; invalid review JSON does the same.
- [ ] 1.6 On deny, 120 second timeout, cancellation, workspace switch, or a version that changed after the read, write nothing. Timeout returns a timeout denial. Cancellation and a workspace switch withdraw the card and use the cancellation wording. A stale confirm tells the agent to re-read. Test those five outcomes on a temp workspace.
- [ ] 1.7 Keep non-sensitive writes on today's review flow. Test that reviewer approval of `src/main.rs` applies with no confirmation in both a trusted and an untrusted workspace, that an untrusted workspace still asks for `build.rs`, and that reviewer denial of `README.md` writes nothing and returns the reason.
- [ ] 1.8 Update `INSTRUCTIONS`, the `workbench_write_file` description, `docs/agent-tools.md`, `docs/harness.md`, and `.agents/skills/ejm-ide-agent/SKILL.md` so a sensitive write waits for the person and a non-sensitive write stays on automatic review. Assert the instruction text in the agent tests. Do not edit `quality.rs` or the lint-on-save path.

## 2. Confirmation UI

- [ ] 2.1 Render one inline card from `item/autoApprovalReview/awaitingUser`, using the existing `.approval-request` rules. Show the workspace-relative path, the category line, the full proposed diff (every hunk line, including a change longer than 20 lines), and the raw path when it differs. Reuse the `ChatEdits` hunk rows without `fileDiffPreview`'s line cap. Test the path, a nested sensitive file, a long diff that is fully present, and a differing raw path.
- [ ] 2.2 Wire Deny and Approve, plus the optional note, to `agent_write_decision`. Deny is first, both buttons are `type="button"`, and Approve is not autofocused. Enter does not approve. Collapse the card to Approved, Denied, Timed out, or Cancelled, with those words in the text, and keep Timed out distinct from Cancelled. A stale confirm shows the re-read failure immediately. Test the note on deny, the four collapsed strings, and that a change longer than 20 lines is still approved from the card.
- [ ] 2.3 Add an optional side-by-side editor tab that uses Monaco `DiffEditor` read-only, with the same options and model cleanup as `GitDiffPane`, fed by the confirmation's before and after rather than `git_diff`. Pin Deny and Approve in the header. Opening or closing the tab does not decide. Test that the tab kind is not a Git request.
- [ ] 2.4 Set the chat activity line to "Waiting for your approval" with a polite live region, and badge "Toggle chat panel" while a confirmation is pending and the panel is hidden. Announce the collapsed states in text. Test the waiting string and the hidden-panel badge.
- [ ] 2.5 Add one OS notification through `tauri-plugin-notification` when the main window is unfocused and a confirmation is pending. Copy: "Edi is waiting to change {file}". Clear it when the confirmation ends. If the plugin capability cannot be included, land 2.4 anyway and record the gap. Test the unfocused vs focused choice with a stubbed focus flag.
- [ ] 2.6 Add a read-only Preferences disclosure under AI assistance that lists the spec's sensitive file names and directory names. Do not add an editor, a workspace setting, or an Option B control. Test that the disclosure has no path editor.

## 3. Verification

- [ ] 3.1 Run the focused web tests and `npm run test:rust` for the classifier, confirmation, and non-sensitive cases. Then run `npm run verify`. In the browser preview, walk the card in light and dark: the full diff is visible, keyboard travel reaches Deny then Approve, and Enter does not approve. Record any OS-notification gap from task 2.5.

## Not in this change

Option B would replace only the non-sensitive requirement: human confirmation by default, with the AI reviewer allowed to approve non-sensitive writes only after an opt-in. It needs a spec edit before any task is added. Suspending auto-lint for agent-changed files stays the follow-up named in the proposal. The extra files in proposal open question 3 stay out until the sensitive-path requirement lists them.

## Workflow follow-up

- Sync specs and archive only after the implementation has landed. This change is the approved design, the tasks, and the Product Manager's proposal and specs.
