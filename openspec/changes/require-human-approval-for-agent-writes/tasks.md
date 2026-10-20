# Tasks

Implement sections 1, 2, and 5, plus either section 3 (Option A, recommended) or section 4 (Option B). Do not implement both 3 and 4. Section 6 is only if Everett asks for both policies as a preference. Tests are part of each task. No paid model calls.

## 1. Shared write gate (common)

- [ ] 1.1 Add the protected-path predicate and proc-macro manifest read (`toml` crate, no Cargo process): case-insensitive normalized paths, the category table in design.md, fail-closed on an unreadable `Cargo.toml`, hard deny unchanged for `.git` and traversal. Unit-test the table, `Build.RS`, a normal `src/lib.rs`, `Cargo.lock`, a proc-macro package, and an unreadable manifest.
- [ ] 1.2 Add an in-memory single-use proposal (UUID, oneshot, prepared write, turn, workspace) on the agent tool state, and `agent_write_decision` with the host token and main-window check. Register it in `src-tauri/build.rs`, the invoke handler, and the generated ACL, and keep the command-parity test passing. Prove `agent_ide_ack` does not resolve a proposal, a second decision fails, and a bad token or window fails.
- [ ] 1.3 Pause inside `reviewed_write` when `confirmation_required` is true, without the 30 second presentation timeout. On approve, re-check the version and call the existing apply path, recording the approval for that version. On reject, cancel, workspace change, or the 20 minute deadline, write nothing and return a tool error the model can read, including the optional note. Test each of those outcomes against a temp workspace, including a stale file that disables apply.
- [ ] 1.4 Defer Clippy and RuboCop from `quality_lint` while a proposal is pending and when a protected on-disk version has no recorded approval. Return status `deferred` with the file name, and do not spawn the tool. Leave Biome, Ruff, gofmt, and `quality_format` on their current paths. Test the deferral and a regression that agent apply does not call lint.
- [ ] 1.5 Update `INSTRUCTIONS`, the `workbench_write_file` description, `docs/agent-tools.md`, `docs/harness.md`, and `.agents/skills/ejm-ide-agent/SKILL.md` so they match the policy section that lands (3 or 4). Cover the prompt assertion in the existing agent tests.

## 2. Confirmation UI (common)

- [ ] 2.1 Render one inline approval card on the chat tool row from `workbench/writeApproval`: category title, normalized path, kind, line counts, the one-line explanation, Edi's latest assistant text when present, advisory reviewer text with no success icon, and the earlier-rejection line. Reuse `fileDiffPreview` and the `ChatEdits` hunk table, capped at about 20 changed lines. Test the category copy, a differing raw path, a new file, a preview that is too large, and Reject-before-Approve tab order with `type="button"` and no autofocus.
- [ ] 2.2 Wire Reject, Approve, and the note disclosure to `agent_write_decision`. Keep the note across a failed decision. Collapse the card to Approved, Rejected, Cancelled, or Couldn't apply, with that word in the text. Disable Approve and offer "Ask Edi to redo" when the host reports a stale file. Test the note on reject, the stale action, and the collapsed strings.
- [ ] 2.3 Add a proposal editor tab that uses Monaco `DiffEditor` read-only, with the same side-by-side options and model cleanup as `GitDiffPane`, fed by the proposal's before and after strings rather than `git_diff`. Pin Reject and Approve in the tab header. Opening or closing the tab does not decide. Test that the tab kind is not a Git request.
- [ ] 2.4 Set the chat activity line to "Waiting for your approval" with a polite live region, and badge "Toggle chat panel" while a proposal is pending and the panel is hidden. Announce Approved, Rejected, and Cancelled in text. Test the waiting string and the hidden-panel badge.
- [ ] 2.5 Add one OS notification through `tauri-plugin-notification` when the main window is unfocused and a proposal is pending. Copy: "Edi is waiting to change {file}". Replace it when the proposal changes and clear it when the proposal ends. If the plugin capability cannot be included, land 2.4 anyway and record the gap. Test the unfocused vs focused choice with a stubbed focus flag, not a real OS permission prompt.
- [ ] 2.6 Add a read-only Preferences disclosure under AI assistance that lists the protected categories and examples. Do not add an editable path list or a workspace setting. Test that the disclosure has no path editor.

## 3. Option A only

- [ ] 3.1 Set `confirmation_required` to the protected-path predicate. Keep the reviewer model as a hard gate for every write: invalid JSON or `approved: false` writes nothing and creates no proposal; `approved: true` on a protected path only opens the card; `approved: true` on any other path applies immediately. Test all three with fixture review text.
- [ ] 3.2 Point the prompt and docs from task 1.5 at this rule: protected paths wait for the person, and a rejection is final for that proposal. Assert the instruction text in the agent tests.

## 4. Option B only

- [ ] 4.1 Set `confirmation_required` to always true. Do not call the reviewer model unless `workbench.agentLlmReview` is on. When it is on, show the verdict as advisory and still wait for the person, including when the reviewer says no. Test an ordinary file with the opt-in off (no model call, no write until the decision) and on (advisory rejection still waits).
- [ ] 4.2 Add the opt-in checkbox to Preferences, default off, stored in `localStorage`, and ignored if a workspace file tries to set it. Test the default and that a pending card is unchanged by toggling it.
- [ ] 4.3 Point the prompt, docs, and agent skill from task 1.5 at this rule: every write waits for the person, and automatic review is not the apply gate. Use the generic card title when the path has no category. Assert the instruction text and the generic title.

## 5. Verification (common)

- [ ] 5.1 Run the focused web tests and `npm run test:rust` for the write, decision, and lint cases. Then run `npm run verify`. In the browser preview, walk the card in light and dark: keyboard from the preview to Reject and Approve, Enter does not approve, the full-diff tab decides through the same buttons, the badge shows with chat hidden, and Preferences shows the read-only list. Record any OS-notification gap from task 2.5.

## 6. Both policies as a preference (only if Everett asks)

- [ ] 6.1 Add the Preferences radio "Ask before agent changes: Build and config files (recommended) / Every file", defaulting to Build and config files, stored outside the workspace. Switching it does not resolve a pending card. Implement 3 and 4 behind that flag instead of picking one. Test both positions, including that a workspace file cannot change the value.

## Workflow follow-up

- The Product Manager owns `proposal.md` and `specs/`. Do not add them here.
- Sync specs and archive only after Everett picks a policy and the implementation change has landed. This change is design and tasks only.
