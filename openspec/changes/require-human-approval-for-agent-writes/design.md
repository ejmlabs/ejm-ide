# Design

## Context

Security finding M1: Edi's file writes are applied when a reviewer model returns `approved: true`. No person confirms the edit. `agent_file_root()` in `src-tauri/src/workspace.rs` rejects only a `.git` path component. In a trusted workspace, saving a document calls `quality_lint`. For a `.rs` file that command runs `cargo clippy`, which compiles the package and executes `build.rs` and proc macros as the user.

The relevant code today:

- `REVIEW_INSTRUCTIONS` and `reviewed_write()` in `src-tauri/src/agent.rs` send the proposal to a tool-less model call and call `edit.apply()` as soon as the JSON says `approved: true`.
- `workbench_write_file` is the only write tool. `EditorTool::execute` in `src-tauri/src/agent/core.rs` always routes that name through `reviewed_write()`. Other tools cannot write files. There is no shell tool.
- `PreparedWrite::prepare` in `src-tauri/src/agent_tools.rs` normalizes the path, rejects `..`, `.git`, symlinks, non-UTF-8, and NUL bytes, and requires the exact `expectedVersion` from `workbench_read_file` (or `null` to create). `apply_checked` writes only if that version still matches.
- The shared harness at pin `09b779ee0452dda07b7f52503be22e65fe238373` runs the tool calls from one model response one after another. `execute_response_tools` awaits each `Tool::execute` before starting the next. The IDE registers `max_sessions: 1`, and a second turn cannot bind while one is running.
- A turn ends at `TURN_TIMEOUT` (20 minutes), which is the harness `run_timeout_ms`. Cancellation and a workspace change already fail `check_current()` and skip the write.
- Presentation tools already pause for a person, but only for up to 30 seconds (`TOOL_TIMEOUT`), and the webview answers with `agent_ide_ack`. That ack means "the interface drew this", not "the person approved a write".
- Chat already renders applied edits with `ChatEdits` and `fileDiffPreview` (`app/components/ChatEdits.tsx`, `app/lib/chat-edits.ts`). Full-file side-by-side diffs use Monaco `DiffEditor` inside `GitDiffPane`, which always loads a Git diff through `git_diff`.
- `quality_lint` runs only from `lintSavedDocument` in `app/App.tsx` after a user save, and only when the workspace is trusted (Markdown lint is local and does not spawn a process). Agent writes go straight to disk through `apply_agent_write` and do not call `quality_lint`. The hole is the next trusted save of a `.rs` or RuboCop file, which builds or loads the project as it sits on disk.
- `quality_format` never runs Cargo or RuboCop. rust-analyzer is started with `checkOnSave: false`, so it does not schedule a second Cargo check. A trusted Rust server can still expand proc macros on its own schedule.
- Preferences live in `EditorPreferences` and `localStorage` keys such as `workbench.lintOnSave`. Nothing in the workspace can change them. The product rule in `.agents/skills/ejm-ide-agent/SKILL.md` says automatic review is the only review policy and forbids an approval-policy picker.

The specs in this change are Option A. Option B stays a follow-up that would replace only the non-sensitive requirement. This design implements the specs.

## Goals / Non-Goals

**Goals:**

- No agent write to a sensitive path reaches disk until the person confirms that exact write in the IDE. AI reviewer approval is not enough.
- The confirmation shows the workspace-relative path and the full proposed change.
- Denial, the 20 minute decision deadline, cancellation, a workspace switch, or a changed on-disk version writes nothing, and the agent hears a failed action. Expiry cancels the write.
- Non-sensitive writes keep today's AI review, version check, confinement, and cancellation behavior.
- The same wait and command can later cover more paths if the non-sensitive requirement is revised.

**Non-Goals:**

- An "always allow" or per-path memory. One confirmation covers one write.
- Ask/Edit modes, a second agent, a shell tool, or a rename, move, or delete tool. The classifier still defines how those mutations would be gated.
- Editing ejm-harness, provider code, Git, or quality-tool code.
- Suspending auto-lint, or sandboxing Clippy, language servers, or other quality tools. The proposal leaves that as a follow-up.
- Git hooks (finding L3), the CSP, or dependency advisories.
- Stopping a running Rust language server. `checkOnSave` stays off.
- A multi-file approval stack. The engine does not present one.
- Persisting a pending confirmation across quit or crash. The file stays unchanged.
- Option B. It is described below so a later change can see the fit, and it is not part of these tasks.

## Decisions

These decisions implement Option A. The wait itself does not depend on which paths are sensitive.

1. **Wait inside `reviewed_write`, on the tool call the harness is already awaiting.** The harness executes the calls from one response in order and will not start the next until this one returns. `reviewed_write` is already async. The human wait uses a oneshot, the same shape as `ToolHost::present`, and does not use the 30 second presentation timeout. The decision deadline is 20 minutes, the same bound as `TURN_TIMEOUT`. When it expires, the write is cancelled and not applied. That is the safe failure, and nothing extends the wait or applies the file on expiry. Stopping the turn or changing the workspace also withdraws the card and writes nothing. The Debug pane value `approvalTimeoutMs` stays a displayed harness limit. It is not this decision deadline.

   Alternative considered: a new harness "pending tool result" state that suspends the run deadline. That can wait longer than 20 minutes, and it could hold every call in the response before the first one runs. It is a shared-engine change, and this fix does not need it. A proposal that outlives the open turn can be re-requested.

   Alternative considered: return a tool result immediately and apply later from a command. The model would continue as if the write had a result before the person decided, which is the bug's shape again.

2. **One pending proposal at a time.** Because calls are sequential and only one turn can bind, a second card cannot be pending in the same session. Calls later in the same response stay inside the harness until this call returns. They are not a queue the UI can approve together.

   Consequence for mixed responses: a normal write earlier in the same response is already on disk before the sensitive card appears. A normal write later in the response waits until this decision returns, then follows the non-sensitive rule. The design does not buffer the whole response. A sensitive path still cannot land before its own confirmation.

3. **A new command, `agent_write_decision`, is the only way to approve.** It takes the per-launch host token and the main-window check that every other command uses. The body is a single-use request id, `approve` or `deny`, and an optional note (at most 1000 characters, no NUL). The id is a UUID created for that proposal and stored next to the oneshot in `AgentToolState`. The command checks that the id is still the active proposal for the current workspace and turn. The first decision wins. A repeat gets "This proposal was already decided." `agent_ide_ack` must not resolve it. A presentation ack means the view updated, and reusing it would let a rendered card count as approval.

   The command is added to the `COMMANDS` list in `src-tauri/build.rs`, the invoke handler, and the generated ACL. The existing parity test in `src-tauri/src/lib.rs` (`every_registered_command_has_a_generated_declaration_and_main_capability`) is the regression.

4. **Re-check the snapshot at decision time, then call the existing apply path.** Approve does not write the bytes the webview echoes back. The host still holds the `PreparedWrite` (path, before, after, expected version, turn owner). `apply_checked` already refuses a stale version, a symlink, or a turn that has moved on. If the person confirms and the file changed, nothing is written and the tool result tells Edi to read the file again. That result is returned immediately. Deny writes nothing and returns a tool error that includes the note when there is one. Either result is the normal tool message, so the loop resumes on its own.

5. **Sensitivity is a pure function over the normalized path.** Create and replace pass the target. A future rename or move passes the source and the destination, and is sensitive if either path is. A future delete passes the target. `workbench_write_file` is the only mutation registered today, and both its create and replace paths call this function. No new tool is added. Text in the file, in tool output, or in the model reply cannot satisfy the function or skip the wait.

6. **Quality-tool code stays as it is.** `quality_lint` and `quality_format` are not modified. A sensitive write cannot affect a later Clippy run until the person has confirmed it, because it is not on disk before then. Suspending lint for other agent edits is the follow-up named in the proposal.

7. **No remembered allow, and no workspace-writable list.** The sensitive set lives in the host binary. A read-only explanation may live in Preferences. A file in the repo must not be able to shrink the list. There is no "allow for this run" control.

8. **Keep the write-tool schema.** `workbench_write_file` stays `path`, `content`, and `expectedVersion`. A model-supplied "reason" field would be untrusted copy and would break current prompts if it were required. The card's reason line uses the latest non-empty assistant text in the turn, truncated, and is omitted when that text is empty. The label says it is Edi's wording and can be influenced by repository content.

## Sensitive-path policy

The predicate classifies the same normalized workspace-relative path the host will write. `file_path` already drops `.` segments and redundant separators, and it accepts an absolute path inside the workspace as that relative path. Compare each segment after Unicode NFKC and ASCII case-folding, so `BUILD.RS`, `cargo.toml`, `.GitHub`, and a fullwidth spelling of `scripts` match. NFKC is what makes a compatibility spelling of an ASCII name the same name. NFC alone does not.

`.git`, in any case and any normalization, is rejected before this predicate. The UI does not offer a confirmation for it.

`..` is rejected as traversal and is not rewritten into a sensitive path. A symbolic link in the target or in a parent is rejected, including when the link would land on a sensitive file. Both of those stay hard errors with no card.

When the model's string differs from the normalized relative path (`./crates/./a/Cargo.toml`, or an absolute path), the card shows the normalized path and the raw string under it.

A path is sensitive when, at any depth:

- the final segment is `build.rs`, `Cargo.toml`, `package.json`, `pyproject.toml`, `setup.py`, `setup.cfg`, `Makefile`, `GNUmakefile`, `Rakefile`, `Gemfile`, `Guardfile`, `Brewfile`, `rust-toolchain`, `rust-toolchain.toml`, `.rubocop.yml`, or matches `*.gemspec` or `*.config.*` (`vite.config.ts`, `eslint.config.mjs`, `pkg.gemspec`)
- any directory segment is `.cargo`, `.github`, `.workbench`, `.vscode`, or `scripts` (`nested/.github/**`, `sub/crate/build.rs`, `sub/crate/.vscode/**`)
- or the file is `.rs` and the nearest `Cargo.toml` at or above it, inside the workspace, has `[lib] proc-macro = true`

The proc-macro check reads that manifest with the `toml` crate. It does not run `cargo metadata` or any other Cargo command, because those execute build scripts. A missing manifest leaves an ordinary `.rs` file unsensitive. An unreadable, unparseable, or symlinked manifest fails closed: the `.rs` file requires confirmation. `src/lib.rs` in a package whose nearest manifest does not set proc-macro, `README.md`, and `Cargo.lock` are not sensitive. `.envrc`, `go.mod`, and `biome.json(c)` stay off the list. The card's one-line explanation follows the directory or file category: build and package manifests, tool config, CI, editor and workspace config, or scripts.

## Confirmation flow

1. The model calls `workbench_write_file`. The harness awaits `EditorTool::execute`, which calls `reviewed_write`.
2. `prepare_write` does today's checks. A bad path, a stale version, or a binary body returns a tool error. No card.
3. The reviewer model runs first for every write. A sensitive path continues to step 4 only after a valid `approved: true`. A denial or invalid review returns a tool error and does not ask the person. A non-sensitive path applies on a valid approval and does not reach step 4. Claims inside the file, tool output, or the review reason do not count as the person's confirmation.
4. The host publishes `item/autoApprovalReview/awaitingUser` on the same review id the AI phase already uses. Today's `started` and `completed` payloads have no diff, and `completed` with `approved` means the write may be applied, so a sensitive approval must not use that status yet. The new payload carries the review id, the normalized path, the raw path when it differs, the change kind, the full before and after, and the deadline instant. The webview renders it with the existing `.approval-request` rules. Nothing in `app/` listens for `item/autoApprovalReview/*` today, so this change adds that listener. The host then waits on the oneshot for at most 20 minutes.
5. Approve and Deny on the card, and the same buttons on the full-diff tab, call `agent_write_decision`. The host checks the token, window, id, and turn. The webview sends the decision only, not the file bytes.
6. Approve re-checks the workspace and version, then `apply_checked`. The tool result is the usual success value, and `item/autoApprovalReview/completed` reports `approved`. If the on-disk version changed, nothing is written and the tool error tells Edi to read the file again. Deny writes nothing and returns a denial. When the 20 minute deadline passes, the write is cancelled and not applied, and the tool result tells Edi the write was not applied. Stopping the turn and a workspace switch withdraw the card and write nothing. A disk error is reported on the card and to Edi.
7. The harness records that tool output and continues the turn. The next call then starts. A later sensitive write needs its own confirmation. The first confirmation does not apply to it.

Stopping the response uses today's `agent_cancel` path. The wait observes the same cancel flag as `check_current`. Quit and crash drop the in-memory oneshot. The file was never written.

## Auto-lint

Auto-lint is unchanged. The proposal puts suspending it out of scope and says this change does not modify quality-tool code. The M1 step this change closes is the unconfirmed write: `build.rs`, proc-macro Rust sources, and the other sensitive files are not on disk for the next trusted save to compile until the person confirms them. Ordinary agent edits can still be on disk when that save runs Clippy or RuboCop. That residual is the follow-up, not a lint gate in this change.

## Option A

This is the behavior the specs require.

- The sensitive-path predicate above is the only extra gate.
- The reviewer model still runs for every write. A missing, invalid, or `approved: false` review leaves the file unchanged and does not show a card. The person cannot override that denial.
- A valid `approved: true` on a sensitive path does not write. It opens the card. The reviewer's `reason` is text on the card, never a checkmark and never a sufficient condition.
- A valid `approved: true` on any other path applies immediately, as today. A denial of `README.md` still returns the reviewer's reason and writes nothing.
- The prompt keeps automatic review, and gains one sentence: a sensitive path is applied only after the person confirms it in the IDE.
- Trusted and untrusted workspaces use the same confirmation. Trust still decides whether quality tools and language servers may run.

Tradeoff: a response that writes `src/lib.rs` and then `build.rs` still lands `src/lib.rs` before the card, because the harness finishes each call in order. `build.rs` still cannot land early. A response that writes `build.rs` first shows the card before any later call in that response runs.

Tradeoff: the reviewer model still sees untrusted repo text, and it can still approve a normal file. That is the current control, kept for paths the spec leaves on the automatic path.

Alternative considered: show the card even when the reviewer rejects, so a person can override. The spec allows the reviewer to deny before the person is asked, and an override would let one click accept an edit that layer called suspicious. Fail closed instead.

## Option B

Not this change. The proposal keeps every requirement and replaces only "Non-sensitive writes keep the current review flow" with: agent writes require human confirmation by default, and the AI reviewer may approve non-sensitive writes only when the person has opted in.

Under that wording, sensitive writes still need a person, and the reviewer may still deny before the prompt. Non-sensitive writes would also wait, unless the opt-in is on, in which case today's AI approval can apply them. The opt-in would not let the reviewer apply a sensitive path, and it would not turn a reviewer denial into advice the person can click past.

The wait, the command, the card, and the classifier are the pieces that follow-up would reuse. It would widen the predicate, add a preference outside the workspace, and change the tests that expect `src/main.rs` to apply with no prompt. It needs a spec edit first. This change does not add the preference or the Designer's A/B radio.

## Closed questions

Everett approved Option A. The sensitive set is the spec list, including `pyproject.toml`, `setup.py`, `Makefile`, `.vscode/**`, `rust-toolchain`, `rust-toolchain.toml`, `Gemfile`, `*.gemspec`, and `.rubocop.yml`, plus `setup.cfg`, `GNUmakefile`, `Rakefile`, `Guardfile`, `Brewfile`, and `.rs` files in proc-macro crates. Directory patterns match at any depth. The reviewer may deny before the person is asked, and that denial stands. There is no A/B preference in this change.

The Designer fixed the decision deadline at 20 minutes. Expiry cancels the write. The last 5 minutes warn in whole minutes. One operating-system notification is sent if the window is unfocused when that warning starts. `.envrc`, `go.mod`, and `biome.json(c)` stay off the list.

## Confirmation UI

Folded from the Designer spec (uploads/require-human-approval-for-agent-writes-ui.md) and checked against `App.tsx`, `ChatPane.tsx`, `ChatEdits.tsx`, `GitDiffPane.tsx`, and `EditorPreferences.tsx`. User-visible copy says Edi where the spec said "Agent".

### Answers to the Designer spec's open questions

1. **The loop can pause on a tool call today.** `execute_response_tools` awaits each call. Awaiting a oneshot inside `reviewed_write` pauses the turn at that call and resumes when the tool result is recorded. No new harness state is required. A batch of pending cards does not form: the next call has not started, and a second session cannot bind. The decision deadline is 20 minutes. When it expires, the write is cancelled and not applied.

2. **The full diff uses Monaco's read-only `DiffEditor`.** Options match `GitDiffPane`: `readOnly`, `originalEditable: false`, and `releaseDiffModelsAfterDispose`. `GitDiffPane` itself cannot show the proposal, because it fetches `git_diff` for a `GitDiffRequest`, and the proposal is not a Git diff yet. The card and an optional editor tab both receive the before and after strings from the event. Closing the tab does not decide. `EditorTab` today is only `file`, `markdown-preview`, and git `diff`, so the proposal needs its own tab kind.

3. **Show the protected-path list, read-only.** Put it in Preferences, in the AI assistance section, as a disclosure: "Edi asks before changing build and config files." List the file names and directory names from the sensitive-path policy, including proc-macro Rust sources. Do not make the list editable, and do not store overrides in the project. People should be able to see why a card appeared. An editable list would let a shorter list reopen M1.

### When the card appears

- The normalized path is sensitive, and the reviewer model returned a valid approval. The reviewer's reason is text on the card. The write is not applied yet.
- A reviewer denial does not show the card.
- An untrusted workspace uses the same card. Trust gates process launch, not this decision.
- The card is inline in the chat thread, on the tool row for that call. It is not a modal. `ChatPane` already keeps the thread visible while the rest of the window stays usable.
- The card uses the existing `.approval-request` rules in `app/styles.css`. Those rules are unused today.

### While it is pending

- The chat activity line, which already renders under the transcript while a turn is running, says "Waiting for your approval". Give that line `role="status"` and `aria-live="polite"`. It has no live-region role today. Focus does not move, so typing in the editor is not interrupted.
- If the chat panel is collapsed (`showChat` is false), the existing "Toggle chat panel" button shows a count badge using the same treatment as `.rail-badge` on Source control. There is no chat item on the activity rail to hang the badge on. The count is 1, because only one proposal can be pending.
- During the last 5 minutes the card adds one line: "This request expires in N min if you don't respond." N is the remaining time rounded up to whole minutes, so it counts down 5, 4, 3, 2, 1. It stays at 1 until the deadline. The line is absent before the last 5 minutes.
- The decision deadline is 20 minutes. There is a deadline, and expiry never applies the write.
- If the main window is not focused when the 5 minute warning starts, the host sends exactly one operating-system notification for that request: "This request to change {file} expires in 5 min if you don't respond." It does not send another as N counts down, and it does not send one when the window is focused at the start of the warning. The host uses `tauri-plugin-notification` and does not grant that plugin to the webview. The in-app badge remains visible either way.

### The card

```
┌─────────────────────────────────────────────────────────────┐
│ Approve change to a build file                              │
│ build.rs  ·  modified  ·  +12 −3                            │
│ Runs or changes what runs when the project builds or       │
│ installs.                                                   │
│                                                             │
│ Edi's reason: "Add a cfg flag for the new feature gate."   │
│ Reviewer note: Requested build change.                     │
│                                                             │
│ ┌ full diff (scrolls; nothing omitted) ──────────────────┐ │
│ │  fn main() {                                           │ │
│ │ + println!("cargo:rustc-cfg=feature_x");               │ │
│ └─────────────────────────────────────────────────────────┘ │
│ Open side-by-side diff                                      │
│                                                             │
│ [ Deny ]  [ Approve ]             Add a note for Edi       │
└─────────────────────────────────────────────────────────────┘
```

- **Title.** "Approve change to a build file", "…to a CI file", "…to an editor config file", "…to a script", or "…to a tool config file". The region is labelled "Approval needed: build.rs".
- **Path line.** Workspace-relative normalized path, `new file` or `modified`, and the `+` / `−` counts. If the model string differed, a second line shows it.
- **Why.** The one line for that category.
- **Edi's reason.** The latest assistant text, as decided above. Omit the row when it is empty.
- **Reviewer note.** The model's `reason` string, as text. A reviewer denial never reaches this card. No green check.
- **Earlier denial.** When this turn already denied this normalized path, add "You denied a change to this file earlier in this run."
- **Diff.** The full proposed change is a read-only Monaco `DiffEditor` (`readOnly`, `originalEditable: false`, `releaseDiffModelsAfterDispose`). The card shows that editor, and "Open side-by-side diff" opens the same before and after strings in an editor tab. Every line is in the editor. The 20-line preview and `fileDiffPreview`'s 600-line cap are not the confirmation. A new file compares against an empty original. The tab header reuses the `tool-subheader` layout from `GitDiffPane`, with Deny and Approve. `GitDiffPane` itself stays a Git view, because it loads `git_diff`. Decisions in the tab call the same command as the card. Closing the tab does not decide.
- **Buttons.** The labels are Approve and Deny, matching the spec. `Button` from `app/components/ui/button.tsx`, both `type="button"`, both `variant="secondary"` so neither is the primary button. Deny is first in the tab order. Do not wrap them in a `<form>`. Do not autofocus Approve. This change adds no keyboard shortcut for Approve. Enter in the editor or the note field must not approve. The Designer label was Reject. The spec's verb is deny, so the button says Deny.
- **Note.** "Add a note for Edi" is a disclosure. The textarea is empty until opened, kept if the decision fails, and sent with Approve or Deny. Most useful on Deny. Cap the field at 1000 characters. The spec does not require the note. It does not change the decision.

### What each decision does in the thread

- **Approve.** If the on-disk version still matches, the host writes. The card collapses to "Approved · build.rs · +12 −3 · View diff". If the version changed, nothing is written, the card says the file changed, and Edi is told to read it again. That result is immediate. It does not wait for a second click.
- **Deny.** Nothing is written. The card collapses to "Denied · build.rs · View proposed diff". The tool error includes the note when present.
- **Timed out.** The 20 minute deadline passed. Nothing is written. The card collapses to "Timed out · not applied" and shows "Ask agent to try again". That button starts a new agent turn whose prompt asks Edi to propose the same path and the same before and after again. The timed-out write stays unapplied. The tool result tells Edi the write was cancelled and not applied.
- **Apply error.** The card shows "Couldn't apply change to build.rs: {message}" and the tool result is that error.
- **Withdrawn.** Stop, disconnect, or a workspace change. "Cancelled · build.rs · not applied".
- Status text is in the collapsed row, not only an icon, and the live region announces it. Timed out and Cancelled use different sentences.

### Several writes

One card for the call that is waiting. After that decision, a later sensitive call asks again. A non-sensitive call earlier in the same response can already be on disk. This change does not hold it, and it does not change lint. A sensitive call still cannot land early. Tool results are recorded in call order.

### Future work

Tool calls are sequential, so this change does not stack several sensitive writes or offer Review all. A later change can add that batch stack if the engine can present more than one tool call at a time.

### Edge cases the app can support

- **New file.** `expectedVersion` is null and `before` is empty. The card says "new file". The diff compares against an empty original and includes the whole new file. Creating `scripts/postinstall.sh` is sensitive because of the `scripts` segment.
- **Large diff.** The card still contains every line, inside the scrollable region. It does not replace the body with "Diff too large". The side-by-side tab shows the same bytes. Agent writes are already limited to 128 KiB.
- **Binary.** Not a card state. `prepare_write` rejects NUL and non-UTF-8 before review. Do not build a binary preview unless a later tool can propose those bytes.
- **Same path denied earlier in the turn.** Covered above. The set is in memory on the turn and cleared when the turn ends.

### Accessibility

- Labelled region, polite announcement, focus left where it was.
- Tab order inside the card: diff (the hunk table is already a tab stop), Open side-by-side diff, Deny, Approve, note disclosure, note field when open.
- No single-key approve and no bare Enter approve.
- Diff meaning uses the sign glyph and the accessible name, not color alone.
- Collapsed states are text and are announced.

### Preference copy

Read-only disclosure: "Edi asks before changing build and config files." followed by the protected file names, directory names, and proc-macro Rust sources. No radio for Option B. That control would implement a policy this spec does not allow. The list is not an editor.

## Risks / Trade-offs

- A 20 minute deadline can outlast a person's attention. Expiry cancels the write, the card says it was not applied, and the person can ask Edi to propose the same change again. Nothing applies the file when the deadline passes.
- The sensitive list can still miss a file that a later tool will execute. `.envrc`, `go.mod`, and `biome.json(c)` stay on automatic review. Option B is the follow-up when that residual is unacceptable.
- An earlier ordinary write in the same response can be on disk before the person sees the sensitive card. This change does not roll it back and does not block lint.
- rust-analyzer may expand proc macros from files already on disk. This change does not stop that server. A new `build.rs` or a new proc-macro `.rs` file is not among those files until the person confirms it.
- The operating-system notification is one event per request, sent from the host when the 5 minute warning starts and the window is unfocused. A focused window gets the in-app line and badge only.
- Holding before/after in the event shows the person the bytes they are confirming. Those strings are already in the tool call. Do not also write them to a new log.
- A habitual Approve click remains possible. Equal-weight buttons, no default focus, no always-allow, and a one-line explanation are the mitigations in this change. They do not make a careless click impossible.
- The reviewer model still reads untrusted file text. That reading cannot apply a sensitive path. It can still apply an ordinary path.

## Migration Plan

- No stored chat migration. Old turns have no pending proposal. A restart drops an in-memory wait and leaves the file as it was.
- The tool schema does not change, so current model prompts keep calling `workbench_write_file` the same way.
- Update `INSTRUCTIONS`, the tool description string, `docs/agent-tools.md`, and `docs/harness.md` in the same implementation so they stop saying every valid reviewer approval is applied.
- Update the agent skill's "automatic review is the only policy" line so a later edit does not delete the human check for sensitive paths. Non-sensitive writes stay on automatic review.
- Do not change `quality.rs` or the lint-on-save path in `App.tsx`.
- The new command ships in the ACL with the binary. Old webviews are not a supported client of a new host.
- Rollback is reverting the change. There is no policy file to migrate.

## Test strategy

Use fixture reviews and local decision injection. Do not call a paid model. `parse_review` already covers malformed reviewer JSON.

Host tests map to the spec scenarios:

- Nested `crates/inner/build.rs` and `sub/crate/build.rs`, both `.cargo/config.toml` and `tools/.cargo/config.toml`, `nested/.github/workflows/ci.yml`, `sub/crate/.vscode/settings.json`, `vite.config.ts`, and `packages/web/eslint.config.mjs` require confirmation. So do `pyproject.toml`, `setup.py`, `setup.cfg`, `Makefile`, `GNUmakefile`, `Rakefile`, `Gemfile`, `Guardfile`, `Brewfile`, `rust-toolchain`, `rust-toolchain.toml`, `pkg.gemspec`, and `.rubocop.yml`. `src/lib.rs` beside a normal manifest does not. `macros/src/lib.rs` beside `[lib] proc-macro = true` does. No test runs Cargo.
- `BUILD.RS`, `cargo.toml`, and `.GitHub/workflows/x.yml` require confirmation. `./crates/./a/Cargo.toml` and the absolute path of `Cargo.toml` classify the same as the relative path. A fullwidth or other NFKC spelling of `scripts` requires confirmation.
- `src/../build.rs` and any `..` path are rejected with no card and no write. A symlink target or symlink parent is rejected the same way, including when it would resolve to a sensitive file.
- Creating `scripts/postinstall.sh` requires confirmation. A classifier call for a rename of `notes.txt` to `build.rs`, and for a delete of `Cargo.toml`, requires confirmation. The tool registry still has no rename or delete tool.
- `.git/hooks/pre-commit` and `.GIT/config` are rejected with no card and no write.
- Reviewer `approved: true` on `build.rs` does not write, and the host emits `awaitingUser` with the path and the full before/after. Content or review text that claims the person already approved does not skip that wait.
- Confirming `Cargo.toml` while the version still matches applies that content and reports success. A second sensitive write after that confirmation waits again.
- Reviewer rejection of `.github/workflows/ci.yml` writes nothing and does not ask. Invalid review JSON does the same.
- Deny writes nothing and returns a denial. A short injected deadline, standing in for the 20 minute bound, writes nothing and tells the agent the write was cancelled and not applied. The warning hook runs once before that deadline and not again. Cancel and a workspace switch withdraw the card and write nothing. Confirming after the on-disk version changed writes nothing and tells Edi to re-read. An unfocused window at the warning produces one notification payload. A focused window produces none. A second check for the same request produces none.
- Reviewer approval of `src/main.rs` applies with no prompt, including when the workspace is untrusted. The same untrusted workspace still asks for `build.rs`. Reviewer denial of `README.md` writes nothing and returns the reason.
- `agent_ide_ack` does not resolve a confirmation. A bad host token or window fails. A second decision fails.
- No test starts Cargo or changes `quality_lint`.

Web tests:

- The card shows the workspace-relative path and the full before and after in a read-only Monaco diff, including a change longer than 20 lines. A differing raw path is shown as well.
- With 5 minutes or less remaining, the card shows "This request expires in N min if you don't respond." N counts down in whole minutes. With more than 5 minutes left, that line is absent.
- Deny is before Approve. Neither button is `type="submit"`. Approve is not autofocused. Enter does not approve. A note is included on deny.
- Approved, Denied, Timed out, and Cancelled rows include those words. The timed-out row is "Timed out · not applied" and includes "Ask agent to try again". That action builds a new-turn prompt with the same path and the same before and after. Timed out and Cancelled are different strings.
- The side-by-side tab is fed with before/after, not a `git_diff` request, and its buttons call the same decision.
- The chat activity line says the turn is waiting, and the chat toggle badge appears when the panel is hidden.
- The Preferences disclosure lists the spec's names and has no path editor.
- Browser preview checks the card in light and dark, including keyboard travel from the diff to Deny and Approve, and Enter does not approve.

Run the focused `npm test` files and `npm run test:rust`, then `npm run verify`, before calling the implementation done.
