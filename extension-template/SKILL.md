---
name: workbench-extension-authoring
description: Build and update a local ejm-ide extension with the fixed panel SDK.
---

# Local ejm-ide extensions

Work only inside `.workbench/extensions/<extension-id>/` for extension changes.
Read `extension.json`, `sdk.d.ts`, and the existing panel before editing.
The entry is bundled TSX using React and React DOM from the host toolchain.
Local CSS imports are supported. Do not add dependencies or package scripts.

Use trusted, maintained tools for solved problems. Reuse the host-approved
React and browser APIs before writing custom infrastructure. The dependency
restriction is part of this sandbox's contract: a missing third-party package
requires a separate host toolchain change, not a local installer or vendored copy.
Keep custom panel code focused on ejm-ide's workflow and the narrow SDK adapter.

The panel runs in a sandbox. Use `window.workbench` to read explicitly shared
context, add a reference or a note to chat, and open a shared source reference.
There is no filesystem, shell, network, native Tauri, or additional model API.
Do not change the SDK or claim to have additional capabilities.

Keep the panel focused on the developer's task. Start with familiar choices,
show only relevant fields, and reveal uncommon controls in a named disclosure.
Use a clear primary action and a clear way back or through errors. Preserve
non-secret drafts, readable content, keyboard access, and focus. Reuse the host's
compact spacing and action labels. Keep full details inspectable and unavailable
capabilities explicit.

Build with the IDE's Build and preview action. A passing build makes a draft;
Enable or Reload activates it. A failed build leaves the active version intact.
Use Disable to unload it and Revert to return to the previous checked version.
New native host capabilities require a desktop application change and rebuild.
