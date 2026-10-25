---
name: ejm-ide-ui
description: Design, implement, or review ejm-ide interface changes, including editor panes, navigation, chat, tool activity, and debugging.
---

# ejm-ide interface

Read [DESIGN.md](../../../DESIGN.md), including its source notes, and
[the engineering skill](../ejm-ide-engineering/SKILL.md). Use maintained
interaction primitives before writing focus, keyboard, menu, tree, drag, or
floating-position machinery. Compose the existing components and tokens first.
If a new primitive is needed, check the package and document the choice.

## Start from intent

- Present familiar choices that answer the developer's immediate question.
  Reveal dependent choices and fields only after the relevant selection.
- Use sensible defaults. Keep optional endpoints, protocol details, limits,
  and uncommon controls under a named Advanced disclosure. Required fields and
  choices stay visible; defaults remain clear and editable when supported. Keep
  task-relevant actions, progress, and status visible.
- Give each step one clear next action and a clear Back or cancel path. Keep
  validation beside the field and explain how to recover from a failed action.
  Preserve non-secret drafts through errors and navigation. Isolate or clear
  credentials when the provider or authentication method changes.
- Show existing connections separately from adding one. Provider setup starts
  with Codex, Anthropic, or API key. The key path then asks for OpenAI-compatible
  or Anthropic-compatible before showing its fields. Derive sign-in availability
  from the shared auth contract; explain an unavailable path and offer a supported
  one. Never imply that an account is connected before it is verified.
- Name actions by their outcome: Connect, Save, Open in editor, Add to chat.
  Keep implementation terms in technical details when they do not help the choice.
- Reduce visible concepts, repeated labels, helper paragraphs, and competing
  buttons before changing density. Keep clear headings, readable content, and
  distinct primary, secondary, and destructive actions.
- Apply these rules when touching setup, Preferences, search, chat, Git, debugging,
  and extensions. Reuse a shared pattern where the interaction is the same.
  Keep full records and advanced details reachable through clear disclosures.

## Keep human coding primary

- Give source the flexible center. Source, documents, diffs, and file previews
  share the main editor's tab and group model. Markdown preview belongs beside
  source as an editor tab, follows its file, and renders the shared live buffer.
- Keep one tab bar per group, with a clear active tab and active group. Use file
  identity and a quiet preview/diff marker instead of a second filename header
  or a competing content-mode strip.
- Keep execution, diagnostics, hierarchy, debugging, and history in bottom tools.
  Use sidebars for navigation and chat. All docked panes remain resizable.
- Reduce chrome and repeated labels. Keep source text at its chosen size.
  Preserve clear pane boundaries, resize handles, active tabs, and focus.
- Put actions beside the content they affect. Keep rare actions in menus.
  Use familiar IDE shortcuts and right-click behavior. Preserve unsaved buffers,
  split/move behavior, and source/preview identity across group changes.
- Use one set of spacing, type, color, and state tokens across editor and chat.
  Icon buttons need accessible names and tooltips; menus retain readable labels.

## Make agent work inspectable

- Keep compact tool rows with status, arguments, output, and errors available.
  Put each file diff with its tool call. Open the same diff in an editor pane.
- Use references for files, selections, callers, diagnostics, Git records,
  and graph nodes. Preserve source identity and stale-context warnings.
- Show the selected provider/model and effort, context use, and cost where
  available. Distinguish unknown values and estimates from measured data.
- Keep Stop, correction, and recovery easy to reach. Preserve reading position
  while streaming and provide a route back to the latest message.
- Auto-review is fixed. References to other products do not authorize Ask/Edit
  modes, an approval-policy selector, or extra confirmation steps.
- Keep the debugger useful: causal spans, timing, full captured request/response/tool/error
  content, and explicit redaction, truncation, dropped data, and sample labels.
  Never present opaque encrypted continuation as readable reasoning.

## Check the interaction

For the changed control, check keyboard selection, focus return, Escape, pointer
and right-click paths, disabled/busy/error states, and a narrow split layout.
For setup and forms, also check first use, edit, Back, cancel, validation, retry,
and draft preservation. Confirm that irrelevant fields disappear and advanced
details remain reachable. Use the primitive's supported behavior instead of
patching DOM events around it.
Inspect rendered pixels for visual changes. Match the current app size and theme
when comparing references. Preserve the user's working buffers during checks.

For each new or touched flow, confirm:

- Choices match the task and sensible defaults are clear.
- One primary action, Back or cancel, and retry are easy to find.
- Errors preserve non-secret drafts and identify the next useful action.
- Relevant controls and status stay visible; full details remain reachable.
- Keyboard, focus, and narrow panes preserve the same path.

For rendering or density changes, inspect resizing, switching panes, scrolling,
and opening a diff. For editor organization, also check source/preview switching,
live unsaved edits, tab selection and closing, moving between groups, splitting,
and narrow tab overflow. Measure a reported slowdown before changing architecture.
Keep findings scoped to the flows actually checked.

## Public website branding

For `website/`, use the Public download site section in
[DESIGN.md](../../../DESIGN.md), [the website skill](../ejm-ide-website/SKILL.md),
and the committed [site source](../../../website/index.html). This source snapshot
includes its [brand assets](../../../website/public/design-kit/),
[font licenses](../../../website/public/design-kit/fonts/), and
[brand and icon notices](../../../website/public/notices.txt). Contributors need
no private brand directory. The asset manifest's historical source paths record
provenance rather than required checkouts.

Active shared tokens, generated themes, reusable visuals, and site infrastructure
belong to `ejm-ui` public exports. Retained design-kit files support the current
asset snapshot and earlier references; change shared behavior in its owner. See
[the shared-repository rules](../ejm-ide-shared-repos/SKILL.md). An upstream brand
asset refresh is an optional maintainer action described in the website skill.

Preserve the supplied SVG wordmark, with IDE as a separate suffix. Keep font and
icon licenses, and distinguish the brand use notice from the IDE's MIT license.
Record every shipping raster's source and hash in
[the asset manifest](../../../.impeccable/download-site-assets.json).

Keep the download page static, accessible, and small. Prefer native HTML controls
for its simple interactions and render Lucide icons at build time. Use real app
images, honest release states, and one main action. Check light/dark, phone and
desktop widths, keyboard paths, and scripts-off content before publishing.

