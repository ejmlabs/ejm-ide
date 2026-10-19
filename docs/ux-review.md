# UX review, October 18, 2026

The rules are in [AGENTS.md](../AGENTS.md), [DESIGN.md](../DESIGN.md), and the
[UI skill](../.agents/skills/ejm-ide-ui/SKILL.md). The engineering and extension
skills apply the same principles within their scope.

Start with intent and familiar choices. Reveal dependent details as needed.
Use defaults, one clear next action, and a useful Back or recovery path. Keep
complete technical detail inspectable. Reduce competing concepts and repeated
controls before shrinking type.

## Coverage

| Surface | Applied change or reviewed pattern |
| --- | --- |
| Model connections | Separate list and guided Codex, Anthropic, or API-key setup; relevant fields first, Advanced closed, fixed actions, draft-safe Back, meaningful focus, clear subscription limits |
| Preferences | Grouped editor/save/AI settings, collapsed shortcuts, direct connection management |
| Model picker | One connection dropdown; search/results retain space even with many profiles; busy changes remain blocked |
| Command/file palette | cmdk selection and arrow/Enter navigation; title-bar search opens files first and supports the command prefix |
| Chat | One setup action, actionable recovery, full error Details with Copy/Wrap, model-refresh action, no automatic request replay |
| Extensions | Panel-first layout, Add menu, one state-based primary action, secondary actions/details, draft capability review, honest browser limits |
| Markdown | Main-editor preview bound to source and the shared live buffer; optional outline; no repeated filename header |
| Project | Open folder uses the folder icon |
| Debug | Removed repeated fixed-policy/tool-registration labels; trace, payload, retention, redaction, and omission details retained |
| Editor groups and diffs | Shared source/diff/preview model, one tab bar per group, scoped actions and menus, Radix tab/menu interaction, retained move/split and dirty-buffer protections |
| Git | Existing staged/unstaged groups, history/compare/blame views, row actions, and detail disclosures reviewed and retained |
| Search and hierarchy | Existing search/status and progressive graph reveal reviewed and retained |
| Chat history/context/usage | Existing local chat menus, source chips, previews, honest usage, and disclosures reviewed and retained |
| Terminal and Problems | Existing task-specific controls and readable results reviewed and retained |

## Editor organization follow-up

The developer rejected the previous tab organization as cluttered and confusing.
Markdown preview now belongs in the main editor with source and diff views.
Bottom tools are reserved for execution, diagnostics, hierarchy, debugging, and
history. Navigation and chat stay in sidebars. These placement rules are recorded
in AGENTS.md, the project skills, DESIGN.md, and PRODUCT.md.

### Verification

- 511 frontend tests passed across 36 files, including shared document retention,
  preview placement and reuse, path changes during Save As, and scoped closing.
- Biome formatting, strict lint, TypeScript, and the production frontend build
  passed. The existing large frontend-chunk warning remains.
- Browser checks in the disposable Harbor workspace confirmed preview beside
  source, reuse of its group, moving an inline preview to the side, source
  recovery, preview retention after closing source, group collapse, right-click
  menus, Close Others, arrow-key selection, pointer focus, narrow tab labels,
  outline toggling, and the bottom tool row without Markdown preview.
- Live unsaved preview behavior is covered by shared-document tests and source
  review. Browser automation could not type into Monaco, so live editing was
  not verified through the browser. Save-error propagation was reviewed in code,
  without runtime fault injection.
- Frontend hot reload was used. No native Rust or sibling harness sources changed
  during this follow-up, and the native binary was not rebuilt.

The evidence below belongs to the earlier setup and declutter pass.

## Earlier setup and declutter evidence

- 492 frontend tests passed across 35 files.
- Biome formatting and strict lint passed, including the Rust formatting check.
- TypeScript and the production frontend build passed.
- Four project/extension skills validate and their local references resolve.
- Browser samples checked chooser/API/Codex/Anthropic paths, Back and non-secret
  drafts, Advanced scrolling with fixed footer actions, initial focus and Escape,
  Preferences access while chat is collapsed, palette arrows/Enter, Markdown
  outline/context actions, and the corrected Extensions header.
- A disposable fixture checked 12 synthetic connections, provider switching,
  the separate connection overview, full error details in a 320px chat width,
  and an existing custom API connection through a Codex round trip. Its URL
  survived, and staged key removal remained explicit. The fixture was removed.
- Short-window setup was checked at 900 by 680. The temporary viewport was reset.

No native Rust or sibling harness sources changed. Native account writes,
live sign-in, hosted inference, and active-extension rendering were not exercised
in the browser sample. Native checks from the earlier package audit remain
separate. The existing large frontend-chunk warning remains.
