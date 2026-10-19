# ejm-ide architecture

Status: local macOS implementation. Layout A and the React/Tauri stack are accepted.

## Small, familiar parts

| Job | Existing tool |
| --- | --- |
| Desktop host and local services | Tauri v2 and Rust |
| Interface | React, TypeScript, Tailwind, shadcn/ui |
| Code editing and diff views | Monaco |
| Resizable panes | react-resizable-panels |
| Caller and callee graph | React Flow |
| Chat charts and diagram layout | Recharts, React Flow, and Dagre |
| Rust intelligence | rust-analyzer over LSP |
| Python intelligence | Pyright over LSP |
| TypeScript intelligence | typescript-language-server over LSP |
| Ruby intelligence | Ruby LSP |
| Go intelligence | gopls over LSP |
| Local code index | Tree-sitter, SQLite FTS5, BM25 and reciprocal rank fusion |
| Agent execution | Shared ejm-harness Rust library |
| Model transport | Shared native Responses transport, with documented compatibility adapters |

React reduces compatibility work for Monaco, React Flow, and shadcn/ui. Preact remains viable through its compatibility layer.

## Ownership

The interface owns presentation and editor state. Rust owns local file access, language-server processes, and the shared agent runtime. Typed Tauri commands and events connect the two.

Monaco and its workers ship locally. Syntax highlighting works without a language server. Semantic actions show the language server's actual status and capabilities.

The central editor owns a split tree of tab groups. Source buffers share Monaco
models across groups; focus selects the editor used by navigation, context,
completion, and cursor-following tools. Git comparisons use separate read-only
models and move through the same tab/group layout. Untitled buffers stay local
until Save As publishes a new workspace file without overwriting an existing
destination.

The visible call graph follows the editor cursor and active buffer after a short
debounce. The language server prepares the symbol under the cursor; document
symbols resolve clicks inside a function body. Discovery and traversal have
separate cancellation scopes so cursor movement within the same function can
reuse a crawl. Buffer revisions invalidate both.

The first graph load follows two levels with a 40-symbol budget. Node controls
reveal up to 20 more symbols upstream or downstream. The session retains the
frontier, visits each symbol once per direction, and keeps cycle and shared-call
links. Cursor movement within the same function preserves revealed branches.
The native LSP
client sends standard cancellation requests. Exact hierarchy items returned by
the server can lead into external dependencies without granting the editor
access to read those files. React Flow and Dagre lay out the accumulated graph;
the root stays fixed while new batches arrive.

Languages without semantic call hierarchy page through immediate SQLite
relationships and apply the same depth and batch budgets. Separate ancestor and
descendant walks avoid unrelated sibling branches. The agent can still traverse the
full graph through the native transitive continuation contract.
Traversal completion describes available static relationships; dynamic dispatch
and unresolved dependencies can remain outside its coverage.

The agent runs when the user sends a message. Attachments identify captured source and ranges. Every proposed file write passes automatic review and conflict checks. Human editing and navigation remain central.

## Shared harness and saved chats

The shared `ejm_harness::Harness` owns the agent loop, resource governor,
tool schema validation, canonical messages and events, cancellation, and
context/repeat/step limits. It is a source dependency on the sibling
`ejm-harness/crates/ejm-harness` checkout.

The IDE supplies a provider adapter, native tools, exact-write automatic review,
rich chat storage, and presentation events. The adapter supports per-send model
and effort changes while the same harness session retains its canonical
history. Native OpenAI uses the shared Responses transport and `ejm-harness-auth`.
Its opaque reasoning continuation survives tool turns and saved chats and is
cleared when provider, account, or model changes. Other protocol adapters remain
until the shared contracts cover their reasoning and diagnostic behavior.
See [Harness design](docs/harness.md) and [the package audit](docs/package-audit.md).

The IDE chat store keeps workspace titles, archive state, tool records, file
diffs, and references. Chat history lists only the current canonical workspace.
It remains available independently of provider selection. Opening a chat pages
through saved rich turns; the shared harness retains canonical model history.

One response can run at a time in the active conversation. Switching, starting
a new chat, and archiving the active chat require it to stop first. Events carry
their chat identity so late output cannot enter another chat. Switching clears
temporary displays, source highlights, hints, and turn ownership.

Debug reads bounded trace snapshots from Rust. Its waterfall shows causal spans
for agent turns, model requests, tools, review, and local IDE operations. Request,
response, tool, and error content loads when a span is selected. Known credentials
are redacted; capture limits and missing records remain visible. Export includes
captured content and warns before writing it to a file. See [Harness design](docs/harness.md).

## References from every pane

Every shipped IDE surface offers Add to chat for its items and current view. Drag-and-drop and the chat's @ picker use that same action. The command works on a focused item through the command palette and a keyboard shortcut.

The composer shows a removable chip for each reference. Each chip offers a content preview and a jump back to its source. The preview shows exactly what will be sent, including any omitted content.

A caller reference contains the caller's symbol and source location, the target symbol, and the selected call site. A caller row can represent several calls, so a symbol-level attachment includes a bounded set of matching sites and shows them in the preview.

Use one small reference record across panes: kind, label, origin, source URI, relevant ranges, captured version, and a bounded content snapshot. Each pane supplies its own content. No separate context subsystem is needed for each view.

Capture the current editor buffer, including unsaved edits, when the item is attached. Keep the snapshot fixed. If the buffer changes, mark the reference as an earlier version and offer Update. If jump-back cannot locate the original content reliably, open the captured snapshot.

Diagnostics preserve the message and affected range. Diff references preserve the selected hunk and its revisions. Terminal references preserve the selected output and associated command. A graph reference preserves the selected node, edge, or visible subgraph. Future panes use the same interaction.

Resolve response links through real IDE references. Paths and symbol labels alone must not stand in for the source the user selected. Attached source remains data, not instructions to the agent.

## Extend the IDE from chat

The user requests BB's self-extension workflow. BB documents an agent workflow that scaffolds, builds, installs, and reloads plugins from a conversation. Its plugins contribute UI surfaces, commands, tools, and skills.

For this IDE, start with a small local extension API for tool panels, commands, and context providers. A panel uses the existing UI components and can expose the same Add to chat references as built-in panes. A versioned manifest names the extension, API version, entry point, and required capabilities.

Example: attach a caller row and ask, "Add a caller checklist grouped by file, with an Add to chat action for each call site." The agent edits a local extension using the supplied template and authoring skill. Build and preview checks the source and opens it beside the conversation. Enable activates the checked version. Reload replaces it in place. Disable and Revert remain in its menu. A failed build preserves the last working version.

Keep the Rust host stable. UI extensions use an isolated surface and a narrow host bridge. Rust checks the extension's identity and granted capabilities. Restrict custom commands explicitly through the Tauri command manifest and per-webview permissions. Separate webviews alone do not restrict custom commands registered with invoke_handler. New native Rust capabilities require a desktop rebuild.

Panels run in an iframe with an opaque origin and `sandbox="allow-scripts"`. A dedicated protocol serves checked panel documents. The host bridge verifies the frame, session, declared capability, and payload. Privileged Tauri commands and native event subscriptions require a secret held by the main interface.

The builder uses esbuild with fixed import and path rules. It checks syntax and bundles the source without loading extension build scripts. It does not perform TypeScript semantic checking. Versions live separately so a checked draft cannot overwrite the active extension before activation. Revert restores an extension version; it cannot reverse external effects.

Automatic review governs agent file proposals. The extension runtime enforces its own capabilities for every host operation. A successful build or an approved source edit does not grant a running extension additional access.

Start with local extensions that reuse editor navigation and context APIs. Add further surfaces when a concrete extension needs them.

## Automatic review

Chat has one fixed policy for agent file writes. The model determines whether a
request needs an answer or edits; the composer has no Ask/Edit or permission
switches.

The host prepares the exact path, prior content, replacement content, and saved
version. A separate model request with no tools must return a valid approval.
Rejection, timeout, and invalid decisions leave the file unchanged. Review
status and rationale appear in chat.

After approval, the host rechecks the workspace, active turn, confined path, and
saved source version. Agent file tools reject Git metadata, symbolic links,
special files, and paths outside the workspace. Creates refuse existing files.
These save checks do not provide an operating-system sandbox. Diff inspection
remains available in chat and the editor.

## Save pipeline

The editor formats the current buffer before a conflict-checked save. Dedicated
formatters read stdin and return text; they never write the source file. Native
language-server formatting is used where advertised. Formatting is undoable.
If the user edits while formatting runs, the stale result is ignored and the
newer buffer is preserved. Saves for a document run in sequence.

After saving, the host notifies the language server and runs the selected fixed
linter command. Lint diagnostics carry the saved version and appear in Problems
and source markers. New edits invalidate old linter markers. Formatter failure
does not prevent saving. Preferences exposes separate format and lint switches.

Biome, rustfmt, and Clippy also enforce the IDE repository's own quality rules
through `npm run verify` and CI. See [Development checks](docs/development.md).

## Local index

Tree-sitter extracts symbols and syntax call candidates from saved source. Pulldown-cmark extracts Markdown heading symbols, excluding code fences and frontmatter.
SQLite stores content hashes, bounded source chunks, symbols, and call links.
FTS5 BM25 results, exact symbol names, and paths are combined by reciprocal rank
fusion. Graph proximity can boost nearby results.

Syntax links carry inferred or ambiguous evidence. Compatible language-server
call results can upgrade links when persisted source hashes still match.
Versioned hits supply both the Search UI and the agent's read-only tools.
The private Tab-completion runtime has no tool access. See [Index and shared
context](docs/indexing.md) for freshness, limits, and context-sharing behavior.

## Agent presentation and navigation

The IDE registers nine tools with ejm-harness: two index tools, two file
tools, and five presentation/navigation tools. Rust validates their input, confines source paths
to the workspace, binds each request to its thread and turn, and limits concurrent
tool executions. The frontend acknowledges an IDE action after applying it.
Navigation checks the saved source hash against the chosen editor buffer and
waits for Monaco to reveal the matching model before reporting success.

Chat displays are declarative blocks: Markdown, callouts, tables, charts, and
node-edge diagrams. The renderer uses the existing React Markdown, Recharts,
and React Flow components. Payload and item limits bound rendering work. The
block kit has no executable HTML, JavaScript, arbitrary selectors, or remote
image loading. Displays use stable IDs for replacement and dismissal, and share
the existing Add to chat reference path.

Tool lifecycle events merge by call ID into compact expandable chat rows.
Arguments and output are bounded, and finished calls retain their terminal
status when a late output delta arrives. Inline predictions have no tools and do not emit tool activity into the
conversation.

See [Agent tools and chat displays](docs/agent-tools.md) for the tool contract.

## Integration boundaries

- ejm-harness is a shared library dependency. The IDE keeps product-specific
  providers, review, tools, and rich chat records in adapters around that contract.
- Provider APIs supply the model connection. OpenAI-compatible and Anthropic
  profiles use native credentials. Native OpenAI also supports shared ChatGPT
  subscription sign-in; the shared auth contract has no native Anthropic
  subscription credential source.
- Inline predictions expose no external or IDE tools and cannot edit files.
- Language features follow advertised server capabilities. Ruby hierarchy uses
  the index because Ruby LSP does not expose semantic callers and callees.
- Custom window close and app Quit actions pass through an unsaved-file guard.
  Dock or system termination is outside the public Tauri prevention hooks.
- Persistent `workbench` tool names, reference URIs, app identity, and storage
  keys remain stable to preserve existing work across the product rename.

## Sources

- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
- [Monaco editor](https://microsoft.github.io/monaco-editor/)
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
- [BB plugin guide](https://getbb.app/plugin-guide)
- [BB plugin authoring release](https://getbb.app/changelog)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
