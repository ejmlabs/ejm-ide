---
name: ejm-ide
description: A compact desktop coding workspace with the agent beside the editor.
colors:
  primary: "#729df3"
  accent: "#87aff7"
  canvas: "#1e1f22"
  foreground: "#d7dae0"
  chrome: "#25262a"
  chat: "#222327"
  border: "#383a42"
  divider: "#34363c"
  muted: "#a3a8b3"
  success: "#93ba8b"
  warning: "#d7b87c"
  error: "#eea0a0"
typography:
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 550
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    lineHeight: 1.7
  action:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 500
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "11px"
  code:
    fontFamily: '"JetBrains Mono", monospace'
    fontSize: "13px"
    lineHeight: "21px"
rounded:
  inset: "3px"
  compact: "4px"
  control: "5px"
  contained: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#15213a"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "5px 11px"
  button-secondary:
    backgroundColor: "#34373f"
    textColor: "#dce0e9"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "5px 11px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "#adb3c0"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "5px 11px"
  button-danger:
    backgroundColor: "#8f3c3c38"
    textColor: "#f2aaaa"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "5px 11px"
  search-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.compact}"
    padding: "7px"
  project-row:
    textColor: "{colors.foreground}"
    height: "25px"
  reference-chip:
    backgroundColor: "#2b3039"
    textColor: "#c3cfe2"
    rounded: "{rounded.control}"
    height: "25px"
  model-controls:
    rounded: "{rounded.compact}"
    height: "27px"
    width: "27px"
  composer:
    backgroundColor: "#25272c"
    rounded: "{rounded.contained}"
  dialog:
    backgroundColor: "#292c32"
    textColor: "{colors.foreground}"
    rounded: "7px"
    padding: "20px"
  chat-callout:
    backgroundColor: "#25272c"
    textColor: "#cfd7e5"
    rounded: "{rounded.compact}"
    padding: "8px 10px"
  tool-activity:
    textColor: "#b4bdcc"
    typography: "{typography.label}"
    padding: "4px 0"
  pane-hint:
    backgroundColor: "#30333a"
    textColor: "#e0e5ef"
    rounded: "{rounded.contained}"
    padding: "7px 11px 11px"
---

# Design System: ejm-ide

## Overview

**Design direction: "The compact coding workspace"**

A compact desktop IDE keeps source code central. Graphite surfaces, quiet dividers, system labels, and readable monospace code follow the accepted JetBrains and early Cursor references. The agent sits beside the editor as a companion.

The current compact layout removes repeated workspace labels and chat onboarding. Most controls use small line icons with tooltips; menus retain full labels. Density comes from slim chrome and closed tools, while source text keeps its own readable scale.

**Key Characteristics:**

- Source code gets the flexible center column.
- Docked panes use tonal separation and thin dividers.
- Blue marks actions, selection, and keyboard focus.
- Compact icons keep labels available through tooltips and menus.

## Interaction principles

Start with what the developer wants to do. Use familiar choices, sensible
defaults, and one clear next action. Reveal each dependent choice when needed;
show only the fields that apply. Keep optional technical configuration under
Advanced and full captured records behind clear detail disclosures.

Provider setup starts with Codex, Anthropic, or API key. After API key, choose
OpenAI-compatible or Anthropic-compatible. Then show the credentials and fields
for that choice. Existing connections have a separate management view. Sign-in
availability follows the shared auth contract; explain unavailable paths and
provide a supported route without implying success.

Keep Back, cancel, retry, and validation clear. Preserve non-secret drafts through
navigation and failures, and keep credentials scoped to the chosen provider and
auth method. Compactness comes from fewer visible concepts, quiet hierarchy, and
less repeated text. Keep content readable and primary actions distinct.

Apply these principles across setup, Preferences, navigation, chat, Git, debugging,
and extension panels. Reuse controls and interaction patterns. Check keyboard
access, focus, narrow panes, and failure states as part of a visible change.

## Colors

The palette uses close graphite tones, light gray text, and restrained blue accents. Frontmatter holds the extracted values.

### Primary

- **Action blue:** primary buttons, active tab lines, selected navigation markers, and keyboard focus.
- **Light blue:** inline accents and activity state.

### Neutral

- **Canvas:** source editor and recessed fields.
- **Chrome:** title bar, Project pane, tabs, and status bar.
- **Chat:** the slightly distinct chat pane.
- **Foreground and muted:** primary text and supporting labels.
- **Border and divider:** control outlines and docked pane edges.

Green, amber, and pale red carry success, warning, and error state. Syntax colors belong to the Monaco theme and retain their code meaning.

**The State Accent Rule.** Use blue for actions, current selection, and focus. Use status colors to explain state.

## Typography

**Interface font:** the native system stack in frontmatter. The root size is (13px); most controls and chat prose use (12px).

**Code font:** JetBrains Mono with a monospace fallback. The editor defaults to (13px) with a computed line height of (21px); Preferences can change the size. The stack is configured in code, and the installed face can vary by machine.

### Hierarchy

- **Title:** pane and message labels, with medium emphasis (550).
- **Body:** chat prose at the recorded body size and line height. Markdown preview uses (13px), a line height of (1.75), and a maximum content width of (75ch).
- **Action:** button labels with medium weight (500).
- **Label:** tool tabs, menus, breadcrumbs, and supporting controls. Status and fine metadata use (10px).
- **Code:** source editing uses the code role. Smaller snapshots and inline code use their local monospace styles.

There is no display type role in the IDE chrome. Document headings inside Markdown remain content hierarchy.

**The Readable Code Rule.** Compact chrome does not shrink source text. Keep the editor at its configured size, with a default of 13px.

## Layout

The window is a full-height desktop workspace. A title bar (38px) sits above an activity rail (37px), Project pane, flexible editor, and chat pane. A status bar (22px) closes the window. Pane headers and editor tabs are (32px); breadcrumbs are (24px).

Project starts at (200px), with bounds of (170px) and (420px). Chat starts at (320px), has a minimum of (290px), and can grow to half the available width. The editor has a minimum width of (380px). Separators are (1px), with blue hover and drag states.

Project and Chat start open. Source, documents, diffs, and file previews use the main editor's groups and tab bars. Bottom tools hold execution, diagnostics, hierarchy, debugging, and history; they start collapsed and open when needed. When open, the tool pane starts at (28%) of the editor column, with a minimum height of (160px). Git inspection opens at a useful reading height when the pane was collapsed. Pane toggles use session state; the implementation does not save a pane layout.

Spacing follows the existing small gaps and short insets, rather than a strict grid. Tree rows are (25px), standard buttons have a minimum height of (29px), and icon controls are usually (27px) square. Title bar icon controls are (25px) square.

The desktop body has a minimum width of (800px). At the existing narrow-window breakpoint (1180px), branch text and secondary symbol detail hide, and tool tabs tighten. Resizable pane minima still constrain narrow windows. There is no mobile layout.

## Elevation & Depth

Docked panes use tonal changes and thin dividers. Floating surfaces use soft dark shadows: menus (`0 6px 25px #0006`), tooltips (`0 5px 16px #0006`), and dialogs (`0 15px 55px #0008`). Focus uses blue outlines or a field border change. Motion is limited to short control transitions (120ms) and activity indicators; reduced motion follows the OS setting.

Temporary pane hints use a lighter graphite surface and the existing floating shadow (`0 8px 28px #0006`). They sit above the named pane, keep its content visible, and offer a close control.

**The Docked Surface Rule.** Keep docked panes flat. Use shadows to separate floating menus, tooltips, dialogs, and notices.

## Shapes

Use rectangular panes with square outer docking edges. Controls and chips use the control radius; small fields and graph nodes use the compact radius. Composer and notices use the contained radius. Dialogs have a slightly larger radius (7px). Dots remain circular. Borders are usually (1px).

Use the existing Lucide line icons, with the shared stroke width of (1.6). Most workbench icons sit between (12px) and (18px); the activity rail uses (17px). Keep icon meaning consistent across panes.

## Components

### Buttons

Compact text or icon controls. Primary buttons use action blue with dark text; secondary buttons use a graphite fill and inset border; ghost buttons have no resting fill. The library also defines a muted red danger variant. Hover changes color or fill without movement. Keyboard focus uses an inset blue outline (2px). Disabled controls use opacity (0.42).

Standard buttons use the recorded action typography and padding. Small buttons use (11px) type with padding of (4px 8px). Icon buttons remove text padding and remain square.

### Inputs and composer

Search fields use a recessed canvas fill, thin outline, compact corners, and a blue focus border. The composer uses a slightly raised graphite fill and contained corners. Its textarea starts at (66px) high and grows up to (240px), with body-sized text and a quiet placeholder.

The single composer toolbar holds Add context, model, effort, Auto-review status, and Send or Stop. Model and effort are icon controls with current-value tooltips and labelled menus. Auto-review is fixed status. There is no Ask/Edit switch or approval-policy selector.

Context use and billing sit inside the same toolbar. A small ring and percentage
show the latest reported context use. Its tooltip gives token counts and makes
clear that unsent drafts are excluded. Billing identifies the sign-in method,
explains provider-dependent billing, and gives cumulative reported tokens. An unknown value stays unknown;
there is no inferred per-chat dollar charge.

### Connections and Preferences

Model connections have their own list, separate from adding or editing one.
New setup starts with Codex, Anthropic, or API key. The key path then chooses
OpenAI-compatible or Anthropic-compatible. The short form shows the account or
key and the required API URL. Optional names, model fallbacks, token limits,
and reasoning format stay under Advanced. Back preserves non-secret fields;
a change of authentication method clears typed secrets and keeps any staged
key removal. The primary action follows the current stage. Anthropic subscription
sign-in is explicitly unavailable until the shared auth contract supports it.

Preferences groups Editor, On save, and AI assistance. Keyboard shortcuts start
collapsed. Manage connections is reachable from Preferences, the command palette,
and chat. Errors give a short explanation and a relevant recovery action, with
full escaped content, Copy, and Wrap in Details. Reconnect never resends a request.

### Navigation

The title-bar search opens files first. Typing `>` opens commands. The shared
palette uses cmdk for selected rows, arrow navigation, and Enter, inside Radix's
dialog. Model search has one current-connection dropdown when multiple connections
exist, so the model list retains its space. Markdown preview is a main-editor
tab bound to its source file and shared live buffer. It uses the group's tab
label rather than a repeated filename header. Outline starts closed and is
absent for documents without headings.

Project rows use a quiet hover fill and a stronger neutral selected fill. Indentation increases by (15px) for each tree level. Long labels truncate. Add to chat appears on hover or keyboard focus. Editor tabs use a blue top line and canvas fill for the active file. The activity rail uses a small blue edge marker for the active tool.

Chat history opens inside the chat pane from a labelled history icon. A search
field and Recent/Archived controls sit above compact rows. Each row has a title,
supporting text, and a menu for rename, archive, or restore. Rename stays inline.
Back returns to the current conversation. During a response, History keeps Stop
available and explains why switching is disabled.

Call graph nodes expose small direction controls for unexplored branches.
Known unread relationships show a count; an unqueried branch shows an ellipsis
with a tooltip. Revealing a branch keeps the root fixed and preserves pan and
zoom. The links list offers the same expansion actions.

### Source reference chips

Compact bordered chips sit above the composer and within messages. A label opens the captured source; a separate action removes the chip. A changed source gets an amber border and dot, plus an explicit Update action. Keep the captured-source state visible.

### Source control and history

The Source control sidebar keeps the branch, upstream status, commit message,
and staged/unstaged groups visible. Small row actions stage, unstage, open, or
attach changes. A file can appear in both groups. A truncated change list or
conflict disables commit. Errors preserve the draft and offer a clear retry.

The wider Git bottom pane holds History, File history, Blame, and Compare.
Commit rows use narrow colored graph lanes, compact branch/tag labels, and a
quiet author/date column. A selected commit opens its message and file changes
beside the list. Dashed graph edges show history beyond the current page.
File history and blame follow the editor; line blame is optional muted text
after the cursor's line, including unsaved changes.

File comparisons open as movable tabs in the main editor, using Monaco's
read-only diff editor with inline/side-by-side and next/previous-change controls.
Git context uses the same Add to chat action
as other panes. Captured commit IDs identify history and do not trigger source
version warnings. Browser sample data stays labelled and cannot mutate Git.

### Editor groups and debug inspection

Each editor group has one tab bar for source, diffs, and document previews.
File identity and a quiet view marker distinguish related tabs. The active tab
connects to its content; focus identifies the active group. Group actions stay
beside the tab bar, with uncommon actions in menus. Radix Tabs and Context Menu
supply selection, keyboard, and menu behavior; ejm-ide owns the document/group
state. react-resizable-panels supplies resizing.

Split right and Split down create resizable groups. Tab dragging and menu actions
move views between groups. Double clicking empty tab-strip space opens a new
untitled buffer. Markdown preview reads the same live document as source, even
across groups. Dirty buffers keep their close and save protections. Blame is a
separate nonselectable widget after the current line, with a clipped label and
full attribution in its tooltip.

Debug uses the bottom tool pane. It combines a causal trace waterfall,
compact connection/activity summaries, and a filtered event timeline. The
inspector shows captured request, response, tool, and error content with
explicit redaction and retention limits.
Running, failed, cancelled, and completed states remain explicit. Tool catalog
and runtime limits use the same quiet rows. Pause, Clear, and export actions
stay in the toolbar. Sample data is labelled; empty and error states explain
the actual runtime state.

### Containers and floating surfaces

Docked containers inherit the Layout and Elevation rules. Menus use compact corners, small item padding, and a lighter highlighted row. Dialogs use a darker overlay, a bordered surface, a short title, and actions aligned to the right. Reference previews use a recessed monospace snapshot.

### Chat displays and tool activity

Structured chat content keeps the same (12px) prose scale and a (12px) gap between blocks. Callouts use a flat composer-colored fill, compact corners, and a thin blue or status-colored edge. Tables use (11px) type, sticky headers, and a scroll area capped at (280px). Charts stay (200px) high; diagrams stay (220px) high and use compact rectangular nodes. Each visual retains a text or table view of its data.

Tool activity uses a compact disclosure row with (11px) labels and (10px) status text. Arguments and results stay behind that row in a monospace area capped at (220px). Long content wraps or scrolls within the chat width.

File diffs live inside their tool call. Its header keeps the tool name, file
count, total added/removed lines, and result visible when collapsed. Edit calls
start expanded; raw arguments and output stay behind Tool details. File disclosure
rows retain their own counts, Open in editor, and Add diff to chat actions. Expanded hunks use old
and new line numbers, the existing syntax palette, and quiet green/red line
fills. The source scroll area is capped at (280px). Applied, failed, stopped,
and declined results remain explicit in live and saved chats. These records
describe the agent's edits at that time, separately from current Git changes.
Large or invalid records state their preview limits. Chat preserves the
reader's position and offers Jump to latest above the composer.

Pane hints use body-sized text, a short (11px) title, and contained corners. Source highlights use a faint blue fill (`#729df326`) and a light blue underline. These marks are temporary and keep source text readable.

## Do's and Don'ts

### Do:

- Do keep Project and Chat docked at startup, with bottom tools collapsed.
- Do reveal tool windows when navigation or a user action needs them.
- Do use the existing line icons, quiet borders, and short sentence case labels.
- Do name icon controls with accessible labels and tooltips.
- Do keep model and reasoning choices in labelled menus and show Auto-review as fixed status.
- Do preserve keyboard focus and source reference actions in compact views.

### Don't:

- Don't add Ask/Edit modes or an approval-policy picker.
- Don't restore repeated workspace titles or chat onboarding to the working surface.
- Don't turn docked panes into floating cards or add decorative shadows.
- Don't reduce the editor font to make chrome fit.
- Don't treat macOS capture indicators or browser-preview labels as native product branding.

## Reference principles

These sources inform the existing compact coding workspace. Apply the relevant
principle to the current task; they do not authorize copying every feature or
changing ejm-ide's fixed auto-review policy.

| Source | Application in ejm-ide |
| --- | --- |
| [VS Code modern UI](https://code.visualstudio.com/blogs/2026/10/15/modern-ui) | Use shared tokens and compact density. Keep active tabs connected to their content and resize boundaries discoverable. Check rendering costs in common editor flows. |
| [JetBrains UI guidelines](https://plugins.jetbrains.com/docs/intellij/ui-guidelines-welcome.html) and [interface overview](https://plugins.jetbrains.com/docs/intellij/ui-overview.html) | Keep source central, tool windows around it, contextual actions near their target, and status information quiet. Use established component behavior. |
| [VS Code UX overview](https://code.visualstudio.com/api/ux-guidelines/overview) | Distinguish editor groups, sidebars, tool panels, and status. Scope each toolbar and context menu to the content it controls. |
| [Agentic UX patterns](https://www.aidesign.guide/agentic-ux-patterns) | Use compact expandable action rows, clear progress and stop controls, visible changes, and rich chat blocks. Details remain inspectable. |
| [Zed agent panel](https://zed.dev/docs/ai/agent-panel) | Make threads, explicit context references, model selection, usage, and edit review work together in one panel. |
| [Microsoft HAX library](https://www.microsoft.com/en-us/haxtoolkit/library/) | Explain capability and limits; make invocation, dismissal, correction, and recovery clear. Report uncertain or partial results honestly. |

Use maintained accessible primitives for these interactions. Custom product
layout and agent behavior should compose those primitives. See
[the UI project skill](.agents/skills/ejm-ide-ui/SKILL.md) for the working checks.

## Public download site

The public site is "ide" by ejmlabs at `ide.ejmlabs.com`. It is an ejm-ui site:
`website/` builds with `ejmlabs({ project: 'ide' })` from `@ejm/site/vite` and
composes its one page from `Hero`, `Section` and the simulated IDE demo from
`@ejm/demos`. The brand files, fonts, font licenses, theme script and headers come
from the `@ejm/*` packages at the revision in `.github/ui-source.json`. Read the
[site notices](website/public/notices.txt). Historical local paths in
[the asset manifest](.impeccable/download-site-assets.json) record earlier inputs.

`ejm-ui` owns active shared tokens, generated themes, reusable visual primitives,
and site infrastructure through public `@ejm/*` exports. The page copy, the
download table and its release data stay in this repository. See
[the website skill](.agents/skills/ejm-ide-website/SKILL.md). The desktop workspace keeps its current committed
palette and density while shared changes follow their owning public contracts.

### Color, type, and identity

Use Paper `#f6f5ef`, Ink `#202721`, Forest `#29443b`, Sage `#8a9a7b`, and Mist
`#e8ede3`. Read text only in the kit's approved pairs: Ink on Paper, Paper on
Forest, and Forest on Mist. Sage is artwork and decoration. Dark mode uses deep
space `#02070d` with Paper text, as on ejmlabs.com.

Use the committed Manrope (400 body, 600 headings) and IBM Plex Mono 500
(eyebrows, versions, statuses, short labels) font files with `font-display: swap`,
and keep both OFL licenses beside them.

Lead with the full ejmlabs logo and put the product name beside it in an
outlined mono tag. Never retype the ejmlabs wordmark. Use the cropped Sage
symbol as hero decoration and close with "Small experiments. Useful things."
Render interface icons from the installed Lucide package at build time.

The editor image shows the actual app. Record each shipped asset's source,
transform, and SHA-256 in
[the asset manifest](.impeccable/download-site-assets.json). Keep this guide
and [the website skill](.agents/skills/ejm-ide-website/SKILL.md) current when
site requirements change. The ejmlabs marks are the owner's artwork; the IDE's
MIT license does not grant rights to them.

### Page and interaction

The kit calls for no more than eight sections, one H1, and one main action.
For this site, that action leads to platform downloads. The composition can
change as the page is redesigned. Use labelled platform choices with keyboard
navigation, truthful availability states, and readable content with scripts
off. Start with the system theme and provide a labelled theme control.

Use static HTML and small native TypeScript modules through Vite. Keep the
first page load under the brand kit's 200 KB target and measure the built result.
Preserve the skip link, main landmark, reduced-motion support, canonical URL,
short description, social metadata, robots file, sitemap, and 404 page.

Only show a working download after its verified installer is published. Keep
platform, architecture, version, checksum, and unavailable states clear. Show
provider billing terms beside the free IDE claim. Cloudflare serves the page,
release metadata, and installers; native build runners produce signed releases.
