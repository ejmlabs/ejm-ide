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

The Product Manager will choose, with Everett, between two policies. This design specifies the shared mechanism first, then each policy. It does not implement either.

## Goals / Non-Goals

**Goals:**

- No agent write to an execution-relevant path reaches disk without an explicit human decision on that proposal.
- A project-executing lint (`cargo clippy`, RuboCop) does not start while such a decision is pending, or while a protected path on disk lacks a recorded approval for its current agent-written version.
- The person sees the diff and chooses Approve or Reject. Approve is a deliberate control, not the action Enter would hit.
- The running turn waits inside the current tool call and then continues with an honest tool result.
- One implementation of the wait, the command, the card, and the lint gate can serve either policy.

**Non-Goals:**

- An "always allow" or per-path memory. One approval must not cover a later edit.
- Ask/Edit modes, a second agent, or a shell tool.
- Editing ejm-harness. The wait stays inside the IDE tool adapter.
- Git hooks (finding L3), the CSP, or dependency advisories.
- Stopping a Rust language server that is already running. `checkOnSave` stays off. Proc-macro expansion by that server is a residual, narrowed by not writing protected sources until approval.
- A multi-file approval stack. The engine does not present one.
- Persisting a pending proposal across quit or crash. The file stays unchanged.

## Decisions

These decisions are the shared machinery. Option A and Option B only change when a card is required and what the reviewer model is allowed to decide.

1. **Wait inside `reviewed_write`, on the tool call the harness is already awaiting.** The harness executes the calls from one response in order and will not start the next until this one returns. `reviewed_write` is already async. The human wait uses a oneshot, the same shape as `ToolHost::present`, and does not use the 30 second presentation timeout. The turn's existing 20 minute deadline still applies. If it fires, or the person stops the turn, or the workspace changes, the wait ends, nothing is written, and the tool result says the proposal was cancelled.

   Alternative considered: a new harness "pending tool result" state that suspends the run deadline. That can wait longer than 20 minutes, and it could hold every call in the response before the first one runs. It is a shared-engine change, and this fix does not need it. A proposal that outlives the open turn can be re-requested.

   Alternative considered: return a tool result immediately and apply later from a command. The model would continue as if the write had a result before the person decided, which is the bug's shape again.

2. **One pending proposal at a time.** Because calls are sequential and only one turn can bind, a second card cannot be pending in the same session. Calls later in the same response stay inside the harness until this call returns. They are not a queue the UI can approve together.

   Consequence for mixed responses under Option A: a normal write earlier in the same response is already on disk before the protected card appears. A normal write later in the response waits until this decision returns, then follows Option A's rule for that path. The design does not buffer the whole response. See Option A for why that leftover window is acceptable once protected paths cannot land early.

3. **A new command, `agent_write_decision`, is the only way to approve.** It takes the per-launch host token and the main-window check that every other command uses. The body is a single-use request id, `approve` or `reject`, and an optional note (at most 1000 characters, no NUL). The id is a UUID created for that proposal and stored next to the oneshot in `AgentToolState`. The command checks that the id is still the active proposal for the current workspace and turn. The first decision wins. A repeat gets "This proposal was already decided." `agent_ide_ack` must not resolve it. A presentation ack means the view updated, and reusing it would let a rendered card count as approval.

   The command is added to the `COMMANDS` list in `src-tauri/build.rs`, the invoke handler, and the generated ACL. The existing parity test in `src-tauri/src/lib.rs` (`every_registered_command_has_a_generated_declaration_and_main_capability`) is the regression.

4. **Re-check the snapshot at decision time, then call the existing apply path.** Approve does not write the bytes the webview echoes back. The host still holds the `PreparedWrite` (path, before, after, expected version, turn owner). `apply_checked` already refuses a stale version, a symlink, or a turn that has moved on. If the file changed, the card stays up with Approve disabled and the tool result tells Edi to read the file again. Reject writes nothing and returns a tool error that includes the note when there is one. Either result is the normal tool message, so the loop resumes on its own.

5. **The policy decision is a pure function over the normalized path.** `confirmation_required(path, policy) -> bool`. Option A passes the protected-path predicate. Option B passes always-true. The wait, the command, the card, and the lint gate call this function. They do not each grow a second copy of the rule.

6. **Project-executing lint consults the same host state.** Before `quality_lint` spawns Cargo or RuboCop, it refuses while a confirmation is pending, and it refuses when a protected path's on-disk version was written by Edi without a recorded approval for that version. The result uses a distinct status, `deferred`, and a short message naming the file. The save itself still succeeds. Biome, Ruff, and gofmt keep running: they are installed tools and do not execute project code. `quality_format` is unchanged. Agent apply does not call `quality_lint`. Trust stays an independent gate: an untrusted workspace still does not spawn these tools, and it still requires approval when the policy says so.

7. **No remembered allow, and no workspace-writable policy.** The protected list and the chosen policy live in the host binary. A read-only explanation may live in Preferences (`localStorage` is acceptable for an opt-in that Option B adds). A file in the repo must not be able to shrink the list. There is no "allow for this run" control. The Designer recommended against it, and a remembered allow on `build.rs` or `.github/**` would reopen M1.

8. **Keep the write-tool schema.** `workbench_write_file` stays `path`, `content`, and `expectedVersion`. A model-supplied "reason" field would be untrusted copy and would break current prompts if it were required. The card's reason line uses the latest non-empty assistant text in the turn, truncated, and is omitted when that text is empty. The label says it is Edi's wording and can be influenced by repository content.

## Protected-path policy

The predicate runs on the path `file_path` / `agent_file_root` have already accepted: absolute, inside the workspace, no `..`, no `.git` component, parent directories opened with symlinks not followed. Match each component case-insensitively. macOS can treat `Build.rs` and `build.rs` as the same file; a case-sensitive check would miss that. On Linux the same rule may ask about a name Cargo would not execute. That extra prompt is the safe direction.

`.git` stays a hard error. Confirmation cannot open it.

The raw string from the model is not the match string. `src/../build.rs` never becomes `build.rs` here; it is rejected as traversal before review. When the raw string differs from the normalized relative path (`./build.rs`, or an absolute path), the card shows the normalized path and the raw string under it.

| Category | Match | What the card says |
| --- | --- | --- |
| Build and package manifests | File name `build.rs`, `Cargo.toml`, `rust-toolchain`, `rust-toolchain.toml`, `package.json`, `pyproject.toml`, `setup.py`, `setup.cfg`, `Makefile`, `makefile`, `GNUmakefile`, `Rakefile`, `Gemfile`, `Guardfile`, `Brewfile`. Any path under a `.cargo` directory. | Runs or changes what runs when the project builds or installs. |
| Tool configs | File name matching `*.config.js`, `*.config.ts`, `*.config.mjs`, `*.config.cjs`, `*.config.mts`, `*.config.cts`. File name `.rubocop.yml`. | Tool config files are code and run when those tools start. |
| CI | Any path under a `.github` directory. | Changes what runs in CI, which may have access to repository secrets. |
| Editor and workspace | Any path under `.vscode` or `.workbench`. | Changes tasks and settings this editor may run automatically. |
| Scripts | Any path under a `scripts` directory. | Scripts in this folder are likely to be run by you or your tools. |
| Proc-macro sources | A `.rs` file whose nearest `Cargo.toml`, walking toward the workspace root, has `[lib] proc-macro = true`. | This package's Rust code runs during compilation, including automatic lint. |

Proc-macro detection reads the manifest with the `toml` crate. It does not run `cargo metadata` or any other Cargo command. Those commands execute build scripts, which is the outcome this change is preventing. If a `Cargo.toml` is present but cannot be parsed, `.rs` files under that package are treated as protected. A missing manifest does not protect ordinary `.rs` files. `build.rs` is protected by name even when the manifest parse fails.

ejm-ide itself does not run npm scripts, Make, or GitHub workflows. Those entries stay on the list because they are the files a later tool or CI job executes, and they are the files named in M1. The files this app actually executes on save are covered by `build.rs`, `Cargo.toml`, `.cargo/**`, `rust-toolchain*`, proc-macro sources, and the RuboCop names above. `quality.rs` maps `.rs` to Clippy and `Rakefile` / `Gemfile` / `Guardfile` / `Brewfile` / Ruby sources to RuboCop.

`Cargo.lock` is not on the list. It does not select code to run.

## Confirmation flow

1. The model calls `workbench_write_file`. The harness awaits `EditorTool::execute`, which calls `reviewed_write`.
2. `prepare_write` does today's checks. A bad path, a stale version, or a binary body returns a tool error. No card.
3. The host evaluates `confirmation_required`. Under Option A the reviewer model runs first for every path. A protected path continues to step 4 only after a valid `approved: true`. Any other review result returns a tool error and skips the card. An ordinary path applies on that approval and does not reach step 4. Under Option B the reviewer model runs only when its preference is on, and it never skips step 4.
4. The host publishes an `agent:event` on the existing channel (`workbench/writeApproval`). The payload carries the request id, thread, turn, connection, normalized path, raw path when it differs, category, change kind (`new` or `modified`), line counts, before, after, the advisory reviewer fields when a review ran, and whether this turn already rejected that path. The webview renders the card. The host waits on the oneshot.
5. The person uses the card or the full-diff tab. Both call `agent_write_decision`. The host checks the token, window, id, and turn.
6. Approve re-checks the workspace and version, records the approval for that path and version, then `apply_checked`. The tool result is the usual `{ path, version, created }`. Reject, cancel, timeout, or a workspace change records nothing and returns an error string the model can read. A disk error uses the same error path; the card shows "Couldn't apply change to {path}: {message}".
7. The harness records the tool output and continues the turn. The next call in the response then starts, or the model takes another step.

The webview must not send the file bytes back. It sends the decision only. The before/after in the event are a display copy of what the host already stored.

Stopping the response uses today's `agent_cancel` path. The wait observes the same cancel flag as `check_current`. The card switches to "Cancelled · {path} · not applied". Quit and crash drop the in-memory oneshot; the file was never written.

## Auto-lint interaction

`quality_lint` is the M1 trigger. Clippy's scope is the Cargo package, not the saved file: saving `src/main.rs` compiles that package and runs its `build.rs` and proc macros. RuboCop loads project config from the workspace.

Shared rule, both options:

- While a `workbench/writeApproval` proposal is unresolved, Clippy and RuboCop return `deferred` and do not spawn. Biome, Ruff, and gofmt still run.
- `QualityState` (or the agent tool state it can read under the lint lock) records protected versions applied by Edi and the approval id that covered them. Clippy and RuboCop also return `deferred` if they would operate on a package or workspace that contains a protected agent-written version with no matching approval. Under both options the approval is recorded before `apply_checked`, so this second check is the invariant, not a second prompt.
- The deferred message names the file and says lint is waiting until that change is decided. The editor save does not roll back.
- Nothing in the agent apply path calls `lintSavedDocument`. If a later change reloads an open model from an agent write, that reload must not lint until the version is approved.

Option A does not defer Clippy for an ordinary source edit that the reviewer model applied. Those files are outside the protected predicate, including the proc-macro rule, so compiling them runs the build scripts and macros already on disk, which a person approved or wrote. The chat still shows that edit through the existing `ChatEdits` row.

Option B never applies any write before approval, so the pending-proposal check is the whole lint interaction. After the last decision, a later user save lints as usual.

Untrusted workspaces never reach the spawn. The deferred status does not replace the trust check.

## Option A

**Human confirmation for protected paths only. Recommended.**

- `confirmation_required` is the protected-path predicate.
- The reviewer model still runs for every write, protected or not. A missing, invalid, or `approved: false` review leaves the file unchanged and does not show a card. The person cannot override a reviewer rejection. A rejection is untrusted too, but the failure direction is "do not write".
- A valid `approved: true` on a protected path does not write. It opens the card. The reviewer's `reason` is advisory text on the card, never a checkmark and never a sufficient condition.
- A valid `approved: true` on any other path applies immediately, as today.
- The prompt keeps automatic review, and gains one sentence: a protected path is applied only after the person approves, and a rejection is final for that proposal.

Why this is the default:

- M1's concrete step is an edit to a file the next Cargo or RuboCop run will execute. Those paths are the ones a person must see.
- Ordinary edits stay on the current automatic review path, so a normal coding turn does not stop on every file.
- The proc-macro rule is what keeps "only the sensitive list" from missing Rust's other execution path. A `src/lib.rs` in a normal package is not executed by Clippy. The same file name in a proc-macro package is.

Tradeoff: a response that writes `src/lib.rs` and then `build.rs` still lands `src/lib.rs` before the card. That file is not execution-relevant under this predicate. The `build.rs` write still cannot land early. A response that writes `build.rs` first shows the card before any later write in that response runs.

Tradeoff: the reviewer model still sees untrusted repo text, and it can still approve a normal file that should have been rejected. That is the current control, kept for files that do not execute during lint. It is no longer the control for protected paths.

Alternative considered: show the card even when the reviewer rejects, so a person can override. That makes a single Approve click able to accept an edit the review layer called suspicious. The card would train the same habitual click M1 is about. Fail closed instead.

## Option B

**A person reviews every agent write. The reviewer model is an opt-in note.**

- `confirmation_required` is always true, including ordinary source.
- The reviewer model does not run unless the person turns it on. The preference is `workbench.agentLlmReview` in `localStorage`, default off, edited from Preferences next to the other AI controls. It is not read from the workspace.
- When the opt-in is on, the model still returns `approved` and `reason`, and the card shows that text as advisory. `approved: false` does not skip the card and does not block Approve. The person is the only apply gate. When the opt-in is off, the card omits the reviewer line and the host makes no reviewer model call.
- The prompt drops "automatically reviews every proposed write" and says every write waits for the person.
- The product sentence in `.agents/skills/ejm-ide-agent/SKILL.md` that forbids any confirmation beyond automatic review has to change with this option. Option A changes it only for protected paths.

Why someone would pick this:

- Path lists miss a file we have not thought of. A new tool config or a script outside `scripts/` would still wait.
- The reviewer model never gates a write, so a prompt-injected approval cannot apply bytes.

Tradeoff: every `workbench_write_file` stops the turn until the person answers, including a one-line edit to a source file they asked for. The 20 minute deadline still cancels an abandoned card. This is the cost the Designer was avoiding by prompting only for protected paths.

Tradeoff: with the opt-in on, a reviewer rejection is only a warning, and Approve still writes. That matches "the person is the policy". It is a weaker automatic backstop than Option A.

## Switching from A to B later

The wait, the oneshot, `agent_write_decision`, the card, the diff tab, the lint deferral, and the approval ledger are the same code. They should be written once, against `confirmation_required`.

The switch is then:

- Change the predicate from the protected-path function to always true.
- Stop treating reviewer `approved: false` as a hard failure, and skip the model call unless `workbench.agentLlmReview` is set.
- Use the generic card title "Approve change to a file" when the path has no category. Protected paths keep their category title and the one-line explanation.
- Update `INSTRUCTIONS`, `docs/agent-tools.md`, `docs/harness.md`, and the agent skill.
- Invert the tests that expect an ordinary file to apply without a card.

No chat migration and no on-disk flag. Pending proposals are in memory only.

That is a small follow-up on top of the shared work, not a second design. The expensive pieces are the pause, the command ACL, the card, and the lint gate. They do not get rewritten to move from A to B.

Shipping both as a user preference is a separate product choice. The Designer spec includes "Ask before agent changes: Build and config files / Every file". The current product rule forbids a policy picker, and a control that can move the security boundary is easy to flip without noticing. This change should implement the policy Everett picks, and expose the list as read-only help. The picker is specified below so it is ready if he wants both, and it is not part of the recommended implementation.

## Confirmation UI

Folded from the Designer spec (uploads/require-human-approval-for-agent-writes-ui.md) and checked against `App.tsx`, `ChatPane.tsx`, `ChatEdits.tsx`, `GitDiffPane.tsx`, and `EditorPreferences.tsx`. User-visible copy says Edi where the spec said "Agent".

### Answers to the spec's open questions

1. **The loop can pause on a tool call today.** `execute_response_tools` awaits each call. Awaiting a oneshot inside `reviewed_write` pauses the turn at that call and resumes when the tool result is recorded. No new harness state is required. A batch of pending cards does not form: the next call has not started, and a second session cannot bind. The wait is not unbounded. The harness deadline is 20 minutes, and the card has no timer of its own. Hitting the deadline cancels the proposal and writes nothing.

2. **Reuse two existing diff views, not `GitDiffPane` as a whole.** The inline preview should use `fileDiffPreview` and the hunk table in `ChatEdits` (sign column, line numbers, sr-only "lines added" / "lines removed"). The full view should use the same Monaco `DiffEditor` options as `GitDiffPane` (`readOnly`, `originalEditable: false`, side by side, `releaseDiffModelsAfterDispose`). `GitDiffPane` itself cannot show the proposal: it fetches `git_diff` for a `GitDiffRequest`, and the proposal is not a Git diff yet. Add an editor-tab kind that holds the before/after strings already on the event. `EditorTab` today is only `file`, `markdown-preview`, and git `diff`.

3. **Show the protected-path list, read-only.** Put it in Preferences, in the AI assistance section, as a disclosure under a `settings-note`: "Edi asks before changing build and config files." Listing the categories and the examples from the table. Do not make the list editable, and do not store overrides in the project. People should be able to see why a card appeared. An editable list would let a shorter list reopen M1.

### When the card appears

- Option A: the normalized path is protected, and the reviewer model returned a valid approval. The verdict on the card is advisory. The write is still not applied.
- Option B: every write that passes `prepare_write`. The reviewer line appears only when the opt-in model call ran.
- An untrusted workspace uses the same card. Trust gates process launch, not this decision.
- The card is inline in the chat thread, on the tool row for that call. It is not a modal. `ChatPane` already keeps the thread visible while the rest of the window stays usable.

### While it is pending

- The chat activity line, which already renders under the transcript while a turn is running, says "Waiting for your approval". Give that line `role="status"` and `aria-live="polite"`. It has no live-region role today. Focus does not move, so typing in the editor is not interrupted.
- If the chat panel is collapsed (`showChat` is false), the existing "Toggle chat panel" button shows a count badge using the same treatment as `.rail-badge` on Source control. There is no chat item on the activity rail to hang the badge on. The count is 1, because only one proposal can be pending.
- There is no notification plugin in the app today (`tauri-plugin-dialog` and `tauri-plugin-opener` are the plugins in `src-tauri/Cargo.toml`). One OS notification per pending proposal, only when the main window is not focused, is part of this change via `tauri-plugin-notification`. Copy: "Edi is waiting to change build.rs". Replace that notification when the proposal changes. Clear it when the proposal ends. Do not emit one notification per file; the engine does not have a file batch. If the plugin's capability or focus check cannot land in the same change, the badge and the activity line still cover the in-app case, and the task list says so.

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
│ ┌ diff preview (first 20 changed lines) ─────────────────┐ │
│ │  fn main() {                                           │ │
│ │ + println!("cargo:rustc-cfg=feature_x");               │ │
│ └─────────────────────────────────────────────────────────┘ │
│ Open full diff                                              │
│                                                             │
│ [ Reject ]  [ Approve ]           Add a note for Edi       │
└─────────────────────────────────────────────────────────────┘
```

- **Title.** "Approve change to a build file", "…to a CI file", "…to an editor config file", "…to a script", "…to a tool config file", or "…to a file" when there is no category (Option B only). The region is labelled "Approval needed: build.rs".
- **Path line.** Workspace-relative normalized path, `new file` or `modified`, and the `+` / `−` counts from `fileDiffPreview`. If the model string differed, a second line shows it.
- **Why.** The one line from the category table. Omit it only for the generic Option B title.
- **Edi's reason.** The latest assistant text, as decided above. Omit the row when it is empty.
- **Reviewer note.** The model's `reason` string, as text. A rejection is not shown on the card under Option A, because that proposal never reaches the card. Under Option B, a reviewer `approved: false` uses the warning tone already used for callouts and names the reason. No green check in either option.
- **Earlier rejection.** When the turn already rejected this normalized path, add "You rejected a change to this file earlier in this run."
- **Diff preview.** The `ChatEdits` hunk table, limited to about 20 changed lines, with `+` / `−` in the sign column as well as color. Added and removed text keep the existing chat-edit colors; contrast has to meet 3:1 for the line backgrounds and 4.5:1 for the text in both themes. The screen reader text already says "lines added" and "lines removed" on the counts. Each changed row should expose "added" or "removed" as well, which the current sign span marks `aria-hidden`.
- **Open full diff.** Opens a read-only editor tab in the active group through `openEditorTab`, titled with the file name. The header reuses the `tool-subheader` layout from `GitDiffPane`: title, then Reject and Approve. The editor is Monaco `DiffEditor` with the proposal's before and after strings. A new file compares against an empty original. Decisions in the tab call the same command as the card. Closing the tab does not decide.
- **Buttons.** `Button` from `app/components/ui/button.tsx`, both `type="button"`, both `variant="secondary"` so neither is the primary button. Reject is first in the tab order. Do not wrap them in a `<form>`. Do not autofocus Approve. This change adds no keyboard shortcut for Approve. Enter in the editor or the note field must not approve.
- **Note.** "Add a note for Edi" is a disclosure. The textarea is empty until opened, kept if the decision fails, and sent with Approve or Reject. Most useful on Reject. Cap the field at 1000 characters.

### What each decision does in the thread

- **Approve.** The host writes. The card collapses to "Approved · build.rs · +12 −3 · View diff". View diff opens the same read-only tab against the applied snapshot. The activity line leaves "Waiting for your approval".
- **Reject.** Nothing is written. The card collapses to "Rejected · build.rs · View proposed diff". The tool error includes the note when present. Edi can propose a different edit.
- **Ask Edi to redo.** Shown only when the host reports the version changed. Approve is disabled. The button sends Reject with a fixed note that the file changed and Edi should read it again.
- **Apply error.** The card shows "Couldn't apply change to build.rs: {message}" and the tool result is that error.
- **Cancelled.** Stop, disconnect, workspace change, or the 20 minute deadline. "Cancelled · build.rs · not applied".
- Status text is in the collapsed row, not only an icon, and the live region announces it.

### Several writes

The spec's stack ("3 changes waiting"), Review all, Reject all, and a multi-file diff with "1 of 3 reviewed" do not match the engine. One tool call is in `execute`. The next call is not running, so the UI cannot list it as a pending file, and Approve all would have nothing honest to apply.

Closest behavior, and the one to build:

- One card for the call that is waiting.
- After that decision, if the next call also needs confirmation, a new card appears and the activity line waits again.
- Non-protected calls earlier in the same response are not held. Under Option A they may already be on disk. The lint gate still refuses Clippy and RuboCop until the pending protected decision finishes, so a save during the wait does not execute the package mid-decision.
- Do not add Approve all. Do not add Reject all. There is no batch to apply together.

The spec asked to confirm tool-result order. Results are recorded in call order, each when that call finishes. The model does not see a later result first. It can see an earlier normal write's success before it sees the protected decision. That is the sequential engine, and Option A accepts it.

### Edge cases the app can support

- **New file.** `expectedVersion` is null and `before` is empty. The card says "new file". The preview is the new content, truncated to the line cap. The full diff's original is empty.
- **Large diff.** Above about 500 changed lines, or a single line too long for the chat table, the card says "Diff too large to preview here" and keeps Open full diff. Approve stays available. `fileDiffPreview` already truncates at 600 lines; the card's cap is tighter.
- **Binary.** Not a card state. `prepare_write` rejects NUL and non-UTF-8 before review. Do not build the binary preview unless a later tool can propose those bytes.
- **Same path rejected earlier in the turn.** Covered above. The set is in memory on the turn and cleared when the turn ends.

### Accessibility

- Labelled region, polite announcement, focus left where it was.
- Tab order inside the card: preview (the existing hunk table is already a tab stop), Open full diff, Reject, Approve, note disclosure, note field when open.
- No single-key approve and no bare Enter approve.
- Diff meaning uses the sign glyph and the accessible name, not color alone.
- Collapsed states are text and are announced.

### Preference copy

Read-only disclosure, both policies: "Edi asks before changing build and config files." followed by the category names and a few examples (`build.rs`, `Cargo.toml`, `.cargo`, `package.json`, `.github`, `scripts`). Option B's implementation replaces the first sentence with "Edi asks before every file change." and keeps the examples as the files that would also explain themselves on the card.

The Designer's two-value control, "Ask before agent changes: Build and config files (recommended) / Every file", is the right copy if Everett exposes both policies. It belongs in the AI assistance section beside Tab completion, as a radio pair, not a mode switch in the chat header. Default is Build and config files. Changing it does not approve a pending card. This control is specified and not recommended for the first implementation. See "Switching from A to B later".

## Risks / Trade-offs

- A 20 minute ceiling cancels an ignored card. The file stays unchanged. Raising `run_timeout_ms` for every turn would let an ordinary run sit for hours. Leave the deadline, and cancel cleanly.
- Option A's path list can miss a future executor. The proc-macro and `rust-toolchain` entries are there because Cargo runs them and the audit list did not name them. A file outside the table still depends on the reviewer model until someone extends the predicate. Option B is the alternative when that residual is unacceptable.
- Option A still applies an earlier ordinary write in the same response before the person sees the protected card. The lint lock covers the wait. It does not roll back the ordinary write.
- rust-analyzer may expand proc macros from files already on disk. This change does not stop that server. It does stop new protected bytes from landing first.
- The OS notification needs a new plugin and a capability entry. The in-app badge does not. Ship the badge either way.
- Holding before/after in the event shows the person the bytes they are approving. Those strings are already in the tool call. Do not also write them to a new log.
- A habitual Approve click remains possible. Equal-weight buttons, no default focus, no always-allow, and a one-line explanation are the mitigations in this change. They do not make a careless click impossible.
- The reviewer model, when it runs, still reads untrusted file text. Option A does not let that reading apply a protected path. Option B does not let it apply any path.

## Migration Plan

- No stored chat migration. Old turns have no pending proposal. A restart drops an in-memory wait and leaves the file as it was.
- The tool schema does not change, so current model prompts keep calling `workbench_write_file` the same way.
- Update `INSTRUCTIONS`, the tool description string, `docs/agent-tools.md`, and `docs/harness.md` in the same implementation so they stop saying every valid reviewer approval is applied.
- Update the agent skill's "automatic review is the only policy" line to match the chosen option, so a later edit does not delete the human check.
- The new command ships in the ACL with the binary. Old webviews are not a supported client of a new host.
- Rollback is reverting the change. There is no policy file to migrate.

## Test strategy

Use fixture reviews and local decision injection. Do not call a paid model. `parse_review` already covers malformed reviewer JSON; extend it only if the advisory payload changes.

Host tests, in `agent_tools` and `agent`:

- The predicate accepts the table above and rejects `src/lib.rs` in a normal package, `Cargo.lock`, and a name that only looks protected as a substring (`not-build.rs`).
- `Build.RS`, `SRC/../build.rs` (rejected as traversal), and a `.git` path (still a hard error) behave as specified. A symlink parent still fails before the predicate.
- A package whose `Cargo.toml` says `proc-macro = true` protects its `.rs` files. An unreadable manifest protects them. A normal manifest does not. The test must not spawn Cargo.
- Option A: reviewer `approved: true` on `build.rs` does not call `apply` until `agent_write_decision` approves. Reject, a second decision, a stale version, cancel, and a workspace change leave the file absent or unchanged.
- Option A: reviewer `approved: false` or invalid JSON on a protected path does not open a proposal and does not write.
- Option A: an ordinary file still applies on a valid approval with no decision command.
- Option B tests replace that last case: an ordinary file does not apply without `agent_write_decision`, and a reviewer rejection still waits for the person when the opt-in is on.
- The decision command fails the host-token and window checks the other agent commands fail, and `agent_ide_ack` does not resolve a proposal.
- `quality_lint` returns `deferred` and does not build a Cargo or RuboCop command while a proposal is pending, and when a protected version lacks an approval record. A Biome path still resolves its tool. An untrusted root still fails before that check.

Web tests, in the chat and preferences suites:

- The card renders the category line, the truncated hunks, and the raw path when it differs.
- Reject is before Approve in the tab order. Neither button is `type="submit"`. Approve is not autofocused. A note is included on reject.
- Stale state disables Approve and the redo action sends the fixed reason.
- Collapsed Approved, Rejected, and Cancelled rows include the text, not only an icon.
- The chat toggle badge appears when the panel is hidden and a proposal is pending, and the activity string is the waiting copy.
- The full-diff tab is a proposal tab fed with before/after, not a `git_diff` request.
- The Preferences disclosure lists the categories and does not render an editable path list.
- Both themes: the added and removed line colors come from tokens already used by chat edits. Check the approval card in light and dark in the browser preview, including keyboard travel from the preview to Reject and Approve.

Run the focused `npm test` files and `npm run test:rust` for the touched crates, then `npm run verify` before calling the implementation done. Browser preview covers the card, the diff tab, the badge, and Preferences. Native process execution of Clippy is not required; the deferred tests assert the command is not started.
