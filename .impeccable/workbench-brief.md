# Workbench mockup review

Mode: Operate. Surface: desktop IDE. Scope: visual layout review before interface implementation.

The user pins the visual reference to JetBrains and the original Cursor, with chat as a companion to human coding. The canonical IDE layout takes precedence over unrelated visual concepts. The concept seed is bdf281c6.

## Direction contract

THESIS: A precise coding workspace keeps source code dominant and semantic help close to the selected method.

OWN-WORLD: Graphite surfaces, quiet dividers, compact system labels, readable monospace code, restrained blue selection, and consistent line icons.

STORY: Open a file, understand a method, follow its relationships, and ask Codex with explicit code context.

FIRST VIEWPORT: Native title bar, project tree, source editor, signature details, focused call hierarchy, and a compact Codex conversation. Three mockups compare the docking arrangement.

FORM: Familiar professional IDE, pinned by the user's JetBrains and early Cursor references. Canonical direction, seed bdf281c6.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Options

- A, balanced: project tree left, editor center, Codex right, call graph below the editor.
- B, editor first: wide editor, temporary hierarchy peek, Codex in the bottom tool window.
- C, code intelligence: editor and graph center, pinned symbol inspector above Codex on the right.

## Review state

All options are illustrative mockups. The user accepted recommended layout A by saying "proceed". Implementation follows that balanced arrangement.

The latest user refinement removes Ask/Edit modes and makes Codex Auto-review the sole approval policy. The model determines whether a request needs edits. A single compact composer toolbar has icon controls for model and effort, context attachment, Auto-review status, and Send. Tooltips name the current choices; menus remain fully labelled. Review status and rationale appear inline when Codex emits them.

The later compact-mode request keeps Project and Codex docked while the bottom
tool window starts collapsed. Remove duplicate workspace labels, chat onboarding,
and the app title from the working surface. Keep source text readable and open
navigation tools when an action calls for them. This refinement supersedes the
mockup's always-visible graph and its denser title bar.

## Reference interaction

Every pane supports Add to chat. A caller row or graph node can become a context chip beside the user's prompt. Drag-and-drop, the @ picker, and a keyboard action reuse the same behavior. A chip previews the captured source and call sites, removes cleanly, and jumps back to the origin. Changed source offers an explicit Update action. Show a caller reference in the next selected-layout revision. The current mockups show a file-range chip but do not yet demonstrate the caller interaction.

## Extension interaction

The user requests BB-style self-extension. A chat request can create a local tool panel using the existing IDE components. Show the extension preview beside the conversation, with Enable, Reload, Disable, and Revert in familiar places. Extension items use the same Add to chat interaction as built-in panes. An extension should fit the existing layout and visual system.
