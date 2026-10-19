# ejm-ide

An open-source desktop IDE for writing and understanding code, with an agent
beside the editor. The agent is named Edi, which is IDE in reverse. Built with React, Monaco, Tauri, Rust, and the shared
**ejm-harness**. The current target is macOS on Apple Silicon.

## Run

Install Node.js 24 LTS, stable Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
Keep the shared harness checkout beside this project:

```text
Desktop/
  ejm-ide/
  ejm-harness/
    crates/ejm-harness/
    crates/ejm-harness-auth/
```

The native app depends on `../../ejm-harness/crates/ejm-harness` from
`src-tauri`. Run these commands from `ejm-ide`:

```sh
npm ci
rustup component add rust-analyzer rustfmt clippy
npm run dev:desktop
```

Use **Open folder** to open a project. The local sample in `examples/harbor`
contains Rust, Python, TypeScript, Ruby, Go, and Markdown. A browser preview is
available with `npm run dev`; native services run in the desktop app.

`dev:desktop` keeps frontend hot reload active and disables Tauri's native
watcher. Saving Rust in the IDE or its harness dependency will not close the
running app for a rebuild. Restart this command after verified native changes.
Use `npm run tauri dev` when you want automatic native rebuilds.

## Connect a model

Open **Model providers** and add an OpenAI-compatible endpoint or Anthropic.
Set its model IDs, output limit, and supported reasoning mode. Provider model
discovery supplies choices where available; configured model IDs remain usable.
Model and effort menus follow the selected profile.

Store an API key in the macOS Keychain or name an environment variable that
contains it. The interface receives key availability, never the stored key.
Local endpoints can run without a key. HTTPS is required for remote endpoints;
HTTP is allowed only for loopback addresses.

For the native OpenAI endpoint, choose **ChatGPT subscription**, sign in in your
browser, and select the account before saving the profile. The shared
`ejm-harness-auth` engine owns login, renewal, and sign-out. Subscription credentials
stay in its private native store; the interface receives public account status.
API-key and subscription requests both use OpenAI's public Responses API with
provider storage disabled. Model and effort choices are preserved.

Other OpenAI-compatible endpoints use Chat Completions. Anthropic uses native
API keys; native Claude subscription login is not available through the shared
auth API. An external Claude Code login is a separate execution integration.
Reported token usage is visible, while exact charges and plan limits remain
with the provider.

## Work in the editor

- Hover for signatures and documentation. Use F12 for definitions and Shift+F12
  for references.
- Split the editor right or down, resize groups, and move tabs between them.
  Each group keeps its own active tab. Double click an empty tab strip to open
  an untitled buffer, then save it to a new path in the workspace.
- Open call hierarchy with Cmd+Option+H. It follows the cursor, active tab, and
  edits. It starts two levels deep, with a bounded first batch. **More callers**
  and **More callees** reveal up to 20 more symbols in that direction. Cycles,
  shared calls, and unresolved branches stay visible. Pan, zoom, or use the full
  links list to inspect the revealed graph.
- Use Search for ranked code and symbol results, plain text, and indexed call
  graphs. Dashed graph links are inferred from syntax; ambiguous links are
  labelled.
- Format and lint on save are enabled by default. Preferences has separate
  switches. Project tool settings control the result.
- Markdown has a live GFM preview, a heading outline, section attachments, and
  local formatting and linting. Open its preview from the editor tab bar.
- Inline completion predicts nearby code after a pause. Tab accepts, Escape
  dismisses, and Cmd+Option+Space requests a prediction. Nearby code is sent to
  the selected provider while this option is enabled. Predictions have no tools.
- Select code and press Cmd+L, drag an indexed result into chat, or use Add to
  chat from a pane. Attachments retain their captured source and version.
- The agent determines whether a request needs an answer or workspace edits.
  Automatic review is the fixed policy for proposed file writes. Each write
  must also pass workspace, turn, path, and source-version checks.
- Tool calls show their status, expandable arguments, and result. File writes
  show their diffs inside the tool call, with line numbers, syntax colors, and
  actions to open the file or attach the changes. Saved chats retain the result.
- The composer shows reported context use and token totals. An unknown context
  limit stays unknown; unsent drafts are excluded. Exact dollar charges are
  unavailable.
- Chat follows new output while you are near the bottom. **Jump to latest**
  returns you there after you scroll back.
- Open chat history to search, resume, rename, archive, or restore this
  workspace's chats. History is stored locally and remains available when the
  provider changes. Stop a response before switching chats.
- The agent can show tables, charts, and diagrams in chat, open source locations,
  highlight code, and place a temporary hint over an IDE pane. Displays can be
  dismissed or added back to chat as context.

The agent searches the same local index and call graph as the IDE. Indexed
files stay local until their contents are attached to chat or returned through
a tool call. See [Index and shared context](docs/indexing.md).

## Arrange editors

Use **Split editor right** in the editor toolbar, or **Split down** in the group
menu. Drag tabs between groups, or use a tab's menu to move them. Source views
share a buffer and keep their own cursor positions. Diffs use the same groups.

Double click empty space in a tab strip to open an untitled file. Press **⌘ S**
to save it to a path inside the workspace. The parent folder must exist. A
failed save keeps the draft open, and an existing file is never overwritten.

## Work with Git

- Open **Source control** for staged and unstaged changes. Stage or unstage a
  file or a whole group, then **Commit staged**. A file can appear in both groups.
  Commits retain Git hooks and signing. If HEAD or the staged snapshot changes,
  refresh and review before committing.
- Open **History** for a commit graph, author/message search, branch and tag
  labels, full commit messages, and changed-file statistics. Load older commits
  in pages, up to 600 per view. Dashed edges mark history outside the loaded set.
- Use **File history** from Source control or the editor's context menu. File
  history and **Blame** follow the active editor. Blame includes unsaved text;
  enable line blame in the editor toolbar for attribution beside the cursor.
- Use **Compare** to compare branches, tags, or commit IDs. The view shows
  ahead/behind counts, the merge base, and changed files.
- Select a changed file for Monaco's read-only diff editor. Switch between
  inline and side-by-side views or jump to the next change. Commit diffs compare
  with the first parent. Diff tabs can move between split groups. Large and
  binary previews state their limits.
- Use **Add to chat** for branches, commits, blame, comparisons, or diffs. These
  attachments preserve the captured Git context.

Git uses the installed Git CLI and stays within the opened workspace. A nested
workspace cannot commit staged files outside its root. Status refreshes while
Source control is visible. Browser preview uses labelled read-only sample data.
Remote operations, branch checkout, rebase, stash, and hosted pull-request
integration are not yet included.

## Inspect the agent runtime

Open **Debug > Traces** for a nested span waterfall. Follow chat turns through
model calls, tools, and review, or inspect saves, formatting, language services,
indexing, and Git. Search, filter errors, expand branches, and zoom the shared
time axis. Select a span for timing, parent links, full requests and responses,
tool arguments and results, and errors.

Activity, Connections, Tools, and Limits remain available. Copy or download the
retained traces and content. Credential redactions, truncation, and eviction are
marked. Capture stays in local memory, with a 128 MiB total limit and a 32 MiB
limit per content item.

ejm-harness owns the agent loop, shared resource governor, canonical messages
and events, and execution limits. The IDE supplies provider adapters, reviewed
file tools, rich chat records, and UI actions. See [Harness design](docs/harness.md).

## Set up languages

See [Language support](docs/languages.md) for server installation, formatter and
linter requirements, executable overrides, and capability limits. Python and
TypeScript server packages and Biome ship with the app. Rust, Ruby, and Go use
installed tools. Ruby formatting needs a formatter in the project bundle.

JSON, JSONC, HTML, CSS, SCSS, and Less have bundled language services and
formatters. YAML, TOML/config, SQL, shell, XML, Dockerfile, and GraphQL files have
syntax highlighting. Other UTF-8 text files open as plain text. Shiki supplies
TextMate syntax colors; language-server semantic tokens refine them where
supported.

## Checks and builds

```sh
npm run format
npm run lint:fix
npm run verify
npm run tauri build -- --debug --bundles app
```

Biome enforces TypeScript, TSX, CSS, and JSON rules. rustfmt and Clippy enforce
Rust rules. CI runs the same verification command. See [Development checks](docs/development.md).

CI checks out the sibling harness from the same GitHub owner's `ejm-harness`
repository and uses its default branch. Set the repository variables
`EJM_HARNESS_REPOSITORY` and `EJM_HARNESS_REF` to choose another repository
or pin a compatible revision. The [development guide](docs/development.md#ci-checkout-layout)
describes the checkout and cache paths.

## More

- [Project rules and skills](AGENTS.md)
- [Architecture](ARCHITECTURE.md)
- [Package audit](docs/package-audit.md)
- [Index and shared context](docs/indexing.md)
- [Local extensions](docs/extensions.md)
- [Agent tools and chat displays](docs/agent-tools.md)
- [Harness and debugging](docs/harness.md)
- [Design](DESIGN.md)

This is a working foundation. Language features depend on server capabilities;
inferred calls can be incomplete, and completion latency depends on the provider.

## License

[MIT](LICENSE). Copyright 2026 ejm-ide contributors.

## Website and desktop downloads

The public download site targets [ide.ejmlabs.com](https://ide.ejmlabs.com).
It builds independently of the desktop UI and uses Cloudflare Worker Static
Assets with R2 for installers. Platform choices include macOS, Windows, and
Linux; download links appear only for published, verified release files.

See [distribution](docs/distribution.md) for local preview, deployment, release
publication, and the remaining native-platform release work.

```sh
npm run site:build
npm run site:check
npm run site:preview
```
