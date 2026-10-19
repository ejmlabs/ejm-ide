# ejm-ide

<!-- impeccable:product-schema 1 -->

## Platform

Desktop for macOS, Windows, and Linux. macOS is the current development target.
Publish each platform only after its release build is verified.
Open source under the MIT license.

## Stack

React and TypeScript for the interface, Tailwind and shadcn/ui controls, Monaco
for editing, and Tauri v2 with Rust for local services. The shared ejm-harness
provides the agent loop and execution contract.

## Users

Developers who write and navigate code themselves, with an agent as a companion.

## Product Purpose

Create an intuitive desktop IDE with the visual care of JetBrains and the
familiar editing workflow of early Cursor.

## Capabilities and Constraints

- Support Rust, Python, TypeScript, Ruby, Go, and Markdown.
- Apply a consistent syntax palette, with semantic symbol colors where a
  language server provides them.
- Support JSON and common configuration, markup, web, query, and shell files.
- Preview Markdown, navigate headings, and reference document sections in chat.
- Show signatures, documentation, and implementation details on hover.
- Navigate definitions, implementations, references, callers, and callees.
- Show a focused call graph for the selected method.
- Start with a shallow graph and let node controls reveal more callers or callees.
- Build on the shared ejm-harness instead of maintaining a second agent loop.
- Support OpenAI-compatible and Anthropic provider profiles, with native key storage.
- Use shared native OpenAI Responses transport and ChatGPT subscription sign-in.
- Include language-server completion and tool-free inline Tab predictions.
- Format and lint on save, with separate switches in Preferences.
- Index code locally for ranked search, symbol navigation, and code graphs.
- Share that index through read-only tools and versioned source results.
- Review each proposed file write automatically, with no approval-policy picker.
- Let the model determine whether a request needs edits, without Ask/Edit modes.
- Use compact icon controls for model and effort, with labelled menus and tooltips.
- Reference IDE content from chat, including callers and callees in navigation panes.
- Show tool progress, arguments, results, and recorded file diffs in chat.
- Show reported context use and token totals, with honest billing information.
- Search, resume, rename, archive, and restore local chats for the workspace.
- Separate staged and unstaged Git changes, stage files or groups, and commit
  the reviewed index.
- Show a paginated commit graph, searchable history, commit details, and comparisons.
- Follow the editor with file history and blame, including unsaved text and line attribution.
- Open source, diffs, and document previews in resizable editor groups, with
  one tab bar per group, movable tabs, and untitled files.
- Keep Markdown preview bound to its file and shared live buffer, including unsaved edits.
- Keep blame annotations separate from source selection and copying.
- Provide a local Debug inspector for agent activity, timing, failures, and limits.
- Let the agent show bounded tables, charts, diagrams, and callouts in chat.
- Let the agent open source locations, highlight code, and place hints over IDE panes.
- Use one Add to chat action across source, navigation, diagnostics, diffs, and terminal output.
- Show references as removable chips with previews and navigation back to the IDE.
- Let the agent extend the IDE through local extensions, inspired by BB's workflow.
- Preview extensions in place and keep Reload, Disable, and Revert available.
- Reuse established libraries and protocols. Keep the interface clear.

## Brand Commitments

The product name is **ejm-ide**. Its agent is named **Edi**, which is IDE in
reverse. Use Edi for the agent in chat labels, prompts, and copy; use ejm-ide
for the program. The user specifies JetBrains visual quality
and the original Cursor layout, where chat supplements human coding. Chrome
should feel as slim as Notion and Linear, with quiet borders and compact controls.
Project and Chat remain docked. Bottom tools start collapsed. Avoid repeated
labels and onboarding on the working surface.

## Product Principles

- Code remains the main workspace.
- Semantic navigation uses language-server facts. Syntax-derived graph links
  are labelled inferred or ambiguous.
- The agent works in the same workspace through explicit host tools.
- Every shipped IDE surface can supply explicit context to chat.
- Local extensions reuse the IDE's context references and narrow panel SDK.
- Use trusted, maintained packages for solved problems. Reserve custom machinery
  for ejm-ide's distinct behavior and necessary adapters; document capability gaps.
- Place documents and file previews in the main editor. Keep execution and
  inspection tools below it, with navigation and chat in sidebars.
- Preserve familiar editor controls, keyboard behavior, and unsaved buffers.
- Start with familiar choices that match the developer's intent. Reveal dependent
  fields when needed and keep uncommon configuration under Advanced.
- Use sensible defaults, one clear next action, and clear Back and recovery paths.
  Preserve non-secret drafts through navigation and errors.
- Keep the workspace compact through clear hierarchy and fewer visible controls.
  Keep full details inspectable and unavailable capabilities explicit.
- Keep canonical agent execution in the shared ejm-harness.

## Open Decisions

- Language debugger scope after the core workflow.
- Advanced Git workflows: remotes, checkout, rebase, stash, and hosted pull requests.

## Distribution

The public site, "ide" by ejmlabs, lives at `ide.ejmlabs.com`. The IDE is free to download and
MIT licensed. AI provider subscriptions and API usage follow the provider's terms.
Use Cloudflare Worker Static Assets for the website and R2 for versioned
installers and release metadata. Use GCP only for a verified Cloudflare gap.
Native operating-system runners compile and sign desktop installers.

Show only verified release files as download links. Until those files exist,
show an honest platform-specific unavailable state. Detect the visitor's platform
as a convenience and keep all platform choices accessible. Do not guess CPU
architecture or publish a development bundle as a release.
