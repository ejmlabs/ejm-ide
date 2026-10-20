# Tasks

This change implements the Option A specs. Do not implement Option B, and do not change quality-tool code. Tests are part of each task. No paid model calls.

## 1. Sensitive-path gate

- [x] 1.1 Classify the normalized workspace-relative path after dropping `.` segments, accepting an absolute path inside the workspace, and comparing segments with NFKC plus ASCII case-folding. Require confirmation for `crates/inner/build.rs`, `sub/crate/build.rs`, `.cargo/config.toml`, `tools/.cargo/config.toml`, `nested/.github/workflows/ci.yml`, `sub/crate/.vscode/settings.json`, `vite.config.ts`, `packages/web/eslint.config.mjs`, `pyproject.toml`, `setup.py`, `setup.cfg`, `Makefile`, `GNUmakefile`, `Rakefile`, `Gemfile`, `Guardfile`, `Brewfile`, `rust-toolchain`, `rust-toolchain.toml`, `pkg.gemspec`, `.rubocop.yml`, `BUILD.RS`, `cargo.toml`, `.GitHub/workflows/x.yml`, `./crates/./a/Cargo.toml`, the absolute path of workspace `Cargo.toml`, a fullwidth spelling of `scripts`, and a new `scripts/postinstall.sh`. Do not classify `src/lib.rs` beside a normal manifest. Require confirmation for `macros/src/lib.rs` when the nearest `Cargo.toml` sets `[lib] proc-macro = true`, using the `toml` crate and not Cargo. Test each of those cases.
- [x] 1.2 Reject `src/../build.rs` and any path containing `..` with no confirmation and no write. Reject a symbolic link, and a parent that is a symbolic link, the same way, including when the link would resolve to a sensitive file. Test both.
- [x] 1.3 Keep `.git` blocked in any case, with no confirmation. Test `.git/hooks/pre-commit` and `.GIT/config`. Expose the same classifier for a future rename or move (sensitive if the source or the destination is) and for a future delete. Test a rename of `notes.txt` to `build.rs` and a delete of `Cargo.toml`. Do not register a rename, move, or delete tool, and keep the existing registry test that those names are absent.
- [x] 1.4 Add an in-memory single-use confirmation (review id, oneshot, prepared write, turn, workspace) and `agent_write_decision` with the host token and main-window check. Register it in `src-tauri/build.rs`, the invoke handler, and the generated ACL, and keep the command-parity test passing. Prove `agent_ide_ack` does not resolve it, a second decision fails, a bad token or window fails, and file text or review text that claims the user already approved does not.
- [x] 1.5 Pause inside `reviewed_write` for a sensitive path only after a valid reviewer approval, for at most 20 minutes, without using the 30 second presentation timeout. Publish `item/autoApprovalReview/awaitingUser` with the path, the full before/after, and the deadline, and do not publish `completed`/`approved` until the person confirms. On confirm, re-check the version and apply that exact content. Test with a short injected deadline, not a 20 minute wait: reviewer approval of `build.rs` writes nothing until confirm; confirming `Cargo.toml` while the version matches reports success; a second sensitive write asks again; reviewer rejection of `.github/workflows/ci.yml` writes nothing and does not ask; invalid review JSON does the same.
- [x] 1.6 On deny, the 20 minute deadline, cancellation, workspace switch, or a version that changed after the read, write nothing. The deadline cancels the write and tells the agent it was not applied. There is no exception that applies the file on expiry. Cancellation and a workspace switch withdraw the card and use the cancellation wording. A stale confirm tells the agent to re-read. Test those five outcomes on a temp workspace with a short injected deadline. Fire the 5 minute warning hook once during that wait.
- [x] 1.7 Keep non-sensitive writes on today's review flow. Test that reviewer approval of `src/main.rs` applies with no confirmation in both a trusted and an untrusted workspace, that an untrusted workspace still asks for `build.rs`, and that reviewer denial of `README.md` writes nothing and returns the reason.
- [x] 1.8 Update `INSTRUCTIONS`, the `workbench_write_file` description, `docs/agent-tools.md`, `docs/harness.md`, and `.agents/skills/ejm-ide-agent/SKILL.md` so a sensitive write waits for the person and a non-sensitive write stays on automatic review. Assert the instruction text in the agent tests. Do not edit `quality.rs` or the lint-on-save path.

## 2. Confirmation UI

- [x] 2.1 Render one inline card from `item/autoApprovalReview/awaitingUser`, using the existing `.approval-request` rules. Show the workspace-relative path, the category line, the full proposed change in a read-only Monaco `DiffEditor` (including a change longer than 20 lines), and the raw path when it differs. Test the path, a nested sensitive file, a long diff that is fully present, and a differing raw path.
- [x] 2.2 Wire Deny and Approve, plus the optional note, to `agent_write_decision`. Deny is first, both buttons are `type="button"`, and Approve is not autofocused. Enter does not approve. Collapse the card to Approved, Denied, "Timed out · not applied", or Cancelled, and keep Timed out distinct from Cancelled. The timed-out card shows "Ask agent to try again", which starts a new agent turn proposing the same path and the same content. A stale confirm shows the re-read failure immediately. Test the note on deny, the collapsed strings, the retry prompt, and that a change longer than 20 lines is still approved from the card.
- [x] 2.3 Add an optional side-by-side editor tab that uses Monaco `DiffEditor` read-only, with the same options and model cleanup as `GitDiffPane`, fed by the confirmation's before and after rather than `git_diff`. Pin Deny and Approve in the header. Opening or closing the tab does not decide. Test that the tab kind is not a Git request.
- [x] 2.4 Set the chat activity line to "Waiting for your approval" with a polite live region, and badge "Toggle chat panel" while a confirmation is pending and the panel is hidden. During the last 5 minutes show "This request expires in N min if you don't respond." with N counting down in whole minutes. Announce the collapsed states in text. Test the waiting string, the hidden-panel badge, and the warning countdown.
- [x] 2.5 When the 5 minute warning starts and the main window is not focused, send exactly one operating-system notification for that request through `tauri-plugin-notification`: "This request to change {file} expires in 5 min if you don't respond." Do not send it when the window is focused, and do not send another as the countdown continues. Do not grant the plugin to the webview. Test focused, unfocused, and once-only with a stubbed focus flag.
- [x] 2.6 Add a read-only Preferences disclosure under AI assistance that lists the protected file names, directory names, and proc-macro Rust sources. Do not add an editor, a workspace setting, or an Option B control. Test that the disclosure has no path editor.

## 3. Verification

- [x] 3.1 Run the focused web tests and `npm run test:rust` for the classifier, the 20 minute deadline (injected short), the warning, the retry prompt, the notification policy, and the non-sensitive cases. Then run `npm run verify`. In the browser preview, walk the card in light and dark: the full diff is visible, keyboard travel reaches Deny then Approve, and Enter does not approve.

## 4. Review correction

- [x] 4.1 Match proc-macro Rust suffixes with the existing Unicode and ASCII case folding while retaining the original path for manifest lookup. Extend the classifier regression to cover mixed-case suffixes and an ordinary-source control. Update the public guide and changelog, run focused and exact-pin full checks within the disk budget, and record their evidence and limits.

### Review verification, 2026-10-20

The earlier scratch classifier contract test failed on `macros/src/LIB.RS`
before the fix and passed after it. That runner imported the production module
and used cached `unicode-normalization 0.1.25`; locked `0.1.26` was absent then.
This historical focused result has now been followed by the exact locked host
checks below. The product manifest, lockfile, and harness pin are unchanged.

Verification used independent clean clones under
`/private/tmp/ejm-audit-verification-20261020/ide11/`: product commit
`1d06b935c6f757a89b171c41fb083f522b17c809`, tree
`bd8837e41f2addd322cab47006567363f72ba2c7`, with harness pin
`09b779ee0452dda07b7f52503be22e65fe238373`, tree
`c98793042e99e9a7c716aee39e69b05428edfaa8`. Source and post-gate provenance
are in `logs/ide11/source-provenance.json` and `post-gate-provenance.json`
under that audit root. `gate-input-hashes.json` records the checked host,
manifest, and gate input hashes. The corrected classifier SHA-256 is
`bb514dfa5756003f213b579305c078d1e9b209f6526c5ee0e509756ce4d847b2`.

The initial cache inventory found six absent locked crate archives. A scoped
official-registry `cargo fetch --locked` downloaded exactly those versions,
including `unicode-normalization 0.1.26`. `cache-preflight.json` records the
initial gap; `03-locked-registry-fetch.log` records the fetch. All following
Cargo checks were offline. No dependency or lock was changed to pass a gate.

Node was `v24.19.0`; Rust was `1.99.1` on `aarch64-apple-darwin`. Every Cargo
command, including nested npm gates, held the exclusive
`/tmp/ejm-capacity-cargo.lock`, used two build jobs, and disabled incremental
compilation. Normal debug profiles were retained. A wrapper excluded credential
environment variables and stopped work if disk fell below 10 GiB. The full gate
used scoped local loopback permission for existing provider fixtures, with no
real provider or account calls.

Raw logs and matching command/result JSON files are under
`/private/tmp/ejm-audit-verification-20261020/logs/ide11/`:

| Log stem | Command | Result |
| --- | --- | --- |
| `01-npm-ci-offline` | `npm ci --ignore-scripts --offline` | Passed, 347 packages, 3.792 s |
| `04-native-check` | `cargo check --manifest-path src-tauri/Cargo.toml --tests --locked --offline` | Passed, 16.506 s |
| `05-npm-verify` | `npm run verify`, once on the exact product commit and harness pin | Passed, 68.022 s |
| `06-site-check` | `npm run site:check` | Passed, 4.156 s |
| `07-site-build` | `npm run site:build` | Passed, 3.265 s |

The full gate passed formatting, lint, strict TypeScript, 622 web tests, strict
Clippy, 217 native unit tests, 8 workspace integrity integration tests, and the
frontend production build. It ran the real classifier regression with locked
`unicode-normalization 0.1.26`, including mixed-case and normalized suffixes.
The normal command still ignores the disposable sample-workspace acceptance
test and six installed-LSP integration tests. The frontend reports the existing
main-chunk warning, about 5.54 MB minified. These command times include any lock
wait and do not measure runtime performance. Final free disk exceeded 26 GiB.

Tauri removed only the final newline from tracked generated
`src-tauri/gen/schemas/macOS-schema.json`. Parsed JSON was identical. The raw
diff and before/after hashes are retained in `generated-schema-newline.patch`
and `generated-schema-newline.json`; only that generated audit output was
restored to its original committed bytes. Final product and harness provenance
is clean, with unchanged runtime and dependency inputs.

The public guide and changelog remain accurate; this verification update changes
only execution evidence. The source-pin site has no authored docs routes, so its
normal site check and build cover the available public site inputs. This pass
did not repeat the browser card, theme, or keyboard acceptance in task 3.1.
Local checks do not establish hosted admission, approval, merge, release,
installer availability, deployment, or website publication.

## Not in this change

Option B would replace only the non-sensitive requirement: human confirmation by default, with the AI reviewer allowed to approve non-sensitive writes only after an opt-in. It needs a spec edit before any task is added. Suspending auto-lint for agent-changed files stays the follow-up named in the proposal. `.envrc`, `go.mod`, and `biome.json(c)` stay off the sensitive list. A batch stack and Review all wait until the engine can present more than one tool call at a time.

## Workflow follow-up

- Sync specs and archive only after the implementation has landed. This change is the approved design, the tasks, and the Product Manager's proposal and specs.
