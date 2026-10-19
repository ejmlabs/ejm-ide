# Local extensions

Extensions add small React panels and commands to the current project. The agent
can edit their source through the same workspace and approval controls used
for other code. The desktop host keeps the runtime and its capabilities fixed.

## Try the notebook

1. Open a project and choose **Extensions** in the activity bar.
2. Choose **Sample notebook** to create `.workbench/extensions/selection-notebook/`.
3. Choose **Build and preview**. This checks the manifest, parses and bundles
   the source, checks imports, and stores a version identified by its SHA-256
   digest. It does not perform TypeScript semantic type checking.
4. Choose **Enable**. Add editor selections, symbols, callers, or other IDE
   references to the chat context. The panel receives those explicit references.
5. Use **Build with Edi** to put a scoped extension request in chat. Review
   the request, then send it. Review the source changes and build a new preview.
6. Choose **Reload** to activate that checked version. **Disable** unloads it.
   **Revert** restores the previous enabled version.

A failed build keeps the enabled version and registry intact. A preview runs
the newly built draft in the sandbox; activation determines which version is
loaded when the project next opens. There is no extension install script.

## Source and versions

Each source directory contains:

```text
.workbench/extensions/<id>/
  extension.json
  panel.html
  panel.tsx
  panel.css
  sdk.d.ts
  SKILL.md
```

The manifest uses `apiVersion: 1`, an id matching its directory, a relative
JavaScript or TypeScript entry, capabilities, and optional commands. Read the
sample manifest and SDK before editing. The host provides React and React DOM.
Local CSS, JSON, SVG, PNG, and WOFF2 imports are supported. Other packages,
network imports, Node imports, source outside the extension, and symlinks are
rejected. The builder uses fixed options and never loads extension build scripts.

Checked bundles live under `.workbench/extension-builds/<id>/<digest>/`.
`.workbench/extension-state.json` records the active, previous, and latest built
versions. State updates use a temporary file and rename. Bundle contents are
verified against their digest before loading or activation.

Building requires Node.js 22 or later. The macOS app includes esbuild and the
React packages used by its builder. An already checked panel does not need Node
to run. The initial desktop package targets Apple Silicon macOS.

## Panel SDK

Use `window.workbench`. Its methods are:

| Method | Capability | Result |
| --- | --- | --- |
| `getContext()` | `context.read` | Current explicit context references |
| `onContextChange(listener)` | `context.read` | Subscribe to new snapshots |
| `addToChat({referenceId})` | `chat.attach` | Attach an existing shared reference |
| `addToChat({label, content})` | `chat.attach` | Attach a plain text note |
| `openSource(referenceId)` | `source.open` | Navigate to an existing shared source |
| `onCommand(listener)` | None | Receive a command declared in the manifest |

Subscriptions return a function that removes the listener. A panel can inspect
at most 12 explicit references, each limited to 4,000 content characters. Notes
are limited to 16,000 characters. Source navigation accepts a shared reference
id, never an arbitrary path supplied by a panel.

Only the selected panel runs. Its declared commands appear in the command
palette while its enabled version is mounted. Previews expose their commands
inside the Extensions panel.

## Runtime boundary

Panels run in an iframe with `sandbox="allow-scripts"` and an opaque origin.
A dedicated document protocol serves only temporary in-memory panel documents.
Its policy blocks network connections, nested frames, workers, forms, and
external code. Panel messages must match the current frame, opaque origin,
session, declared capability, and payload limits.

The SDK has no filesystem, terminal, native command, credential, or model API.
Privileged desktop commands require a secret held by the main interface.
Native event subscriptions use that same authenticated host channel. Extending
these capabilities requires changing and rebuilding the desktop application.

This boundary applies to a running panel. Agent source edits pass the IDE's
automatic review and workspace checks before the host applies them.

## Limits

The host accepts at most 64 extensions per project, 200 source entries and 2 MiB
of source per extension, eight directory levels, and 4 MiB per stored bundle.
Builds time out after 45 seconds. Old bundles remain on disk for rollback and
are not removed automatically. There is no marketplace, background extension
process, package installer, or arbitrary native plugin loader.
