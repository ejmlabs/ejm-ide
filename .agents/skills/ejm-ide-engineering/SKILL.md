---
name: ejm-ide-engineering
description: Implement, debug, or review ejm-ide code and dependency choices. Use for the Rust host, TypeScript app, build tooling, and shared harness integration.
---

# ejm-ide engineering

Use trusted, maintained tools for standard problems. Write ejm-ide's distinct
behavior and the thin adapters that join those tools. Read the root
[AGENTS.md](../../../AGENTS.md) and the relevant subsystem docs before editing.

## Make the package decision first

Check platform and standard APIs, then installed dependencies. If they do not
fit, check an established package's current maintenance, license, security,
platform support, resource cost, and required behavior. Use it when it fits.
Do not infer maintenance from download counts or a familiar name.

For custom infrastructure, state what the package cannot do and why ejm-ide
needs it. Put that reason next to the code or in the subsystem design note.
A short mapper, capability check, or product reducer needs no new package.
Reimplementing standard machinery needs evidence beyond convenience or size.

For a replacement, trace all callers and preserve errors, cancellation, bounds,
ordering, persistence, and compatibility. Cover the concrete failure or guarantee
with a focused regression. Do not substitute a less capable shared adapter.

## Reuse these boundaries

| Need | Existing owner |
| --- | --- |
| Editing, diff models, completions, semantic tokens | Monaco and real LSP servers |
| Syntax grammars and Markdown | Shiki, unified/remark, react-markdown, pulldown-cmark |
| Graph rendering, layout, charts, pane resizing | React Flow, Dagre, Recharts, react-resizable-panels |
| Menus, dialogs, popovers, tooltips, focus | Shared UI components and Radix primitives |
| Editor tab selection and tab menus | Radix Tabs and Context Menu; ejm-ide owns document/group state |
| Command and file palette selection | cmdk within the shared Radix dialog |
| HTTP, URL handling, async tasks and cancellation | reqwest, url, Tokio, tokio-util |
| Agent loop, canonical events, provider transport, login | Sibling ejm-harness and ejm-harness-auth |
| Search storage, syntax parsing, file traversal | rusqlite/SQLite FTS5, Tree-sitter, ignore |
| Filesystem confinement, process execution | cap-std/cap-fs-ext and terminal::run_bounded |
| Trace ancestry and credential pattern matching | tracing/tracing-subscriber and Aho-Corasick |

ejm-ide owns context references, semantic evidence and freshness, graph reveal
policy, review policy, IDE tool contracts, editor groups, and trace/chat
presentation. Compose maintained components under those rules.

## Work with shared packages

Keep changes in this IDE checkout. The "ejmlabs cli" session owns the sibling
harness, auth, and CLI repositories; coordinate missing APIs with it. Read the
sibling harness's `docs/ide-integration.md` and `docs/auth.md` for current contracts.
Keep provider/account/model bindings and opaque continuation intact. Missing
usage is unknown. Provider-specific detail is part of totals, not extra tokens.
Use local fixtures for tests; never make paid model calls in automated checks.

## Keep capabilities and UI aligned

Expose verified capabilities and useful status through the IDE adapter. Keep
provider protocol and transport details in the shared packages. Model setup as
explicit choices so unrelated fields and invalid combinations cannot leak into
the next step. Preserve non-secret drafts across Back, retry, and failed saves;
keep credential handling bound to the selected provider and auth method.
Follow the UI skill's intent and disclosure rules across product surfaces.

Keep source, diff, and document-preview views in the same editor-group model.
A preview retains its file identity and reads the shared document buffer, so
unsaved edits and save state stay consistent across groups. Compose maintained
tab, menu, and resizing primitives around ejm-ide's group reducer. Keep selection,
focus, closing, moving, and splitting consistent without duplicate tab bars.

## Verify and retain decisions

Use [docs/development.md](../../../docs/development.md) for the required checks.
Format only this Rust package when sibling path dependencies are present.
Follow [the UI skill](../ejm-ide-ui/SKILL.md) for visible changes. Review the
actual result, including failure and cleanup paths. Record evidence and remaining
candidates in [docs/package-audit.md](../../../docs/package-audit.md) when doing
a package audit. Do not claim a registry or advisory review from source inspection.
