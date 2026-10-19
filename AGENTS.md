# ejm-ide project rules

## Read the project skills

Open the skill that matches the work before you start. Skills live in
`.agents/skills/`. When work spans two areas, read both.

| Work | Skill |
| --- | --- |
| Code, dependencies, architecture, reviews | [ejm-ide-engineering](.agents/skills/ejm-ide-engineering/SKILL.md) |
| Interface and interaction (also read [DESIGN.md](DESIGN.md)) | [ejm-ide-ui](.agents/skills/ejm-ide-ui/SKILL.md) |
| Colors, light and dark themes, editor theme | [ejm-ide-theme](.agents/skills/ejm-ide-theme/SKILL.md) |
| Edi, IDE tools, review, chat displays, traces | [ejm-ide-agent](.agents/skills/ejm-ide-agent/SKILL.md) |
| Names, labels, and copy for the product | [ejm-ide-naming](.agents/skills/ejm-ide-naming/SKILL.md) |
| Harness, CLI, design kit, and other sessions | [ejm-ide-shared-repos](.agents/skills/ejm-ide-shared-repos/SKILL.md) |
| Checks, browser preview, screenshots, disk limits | [ejm-ide-verify](.agents/skills/ejm-ide-verify/SKILL.md) |
| The public site at ide.ejmlabs.com | [ejm-ide-website](.agents/skills/ejm-ide-website/SKILL.md) |
| Installers, manifest, downloads | [ejm-ide-release](.agents/skills/ejm-ide-release/SKILL.md) |
| Sandboxed panels | [extension-template/SKILL.md](extension-template/SKILL.md) |

## Names

The program is **ejm-ide**. Its agent is **Edi** (IDE in reverse). The public
page is "ide" by ejmlabs. The shared engine is **ejm-harness**. Use Edi when the
agent speaks or acts and ejm-ide when the program does. Keep the stable
identifiers the naming skill lists, such as `workbench_*` tools and `workbench.*`
storage keys.

## Repository map

| Path | Holds |
| --- | --- |
| `app/` | React and TypeScript interface, theme tokens, and web tests |
| `src-tauri/` | Rust host: language servers, index, Git, terminal, providers, Edi's tools |
| `website/` | Public site source; `website/dist` is build output |
| `distribution/` | Cloudflare Worker, release manifest, and publisher |
| `docs/` | Subsystem guides; read the one for the area you change |
| `extension-template/` | Fixed SDK and sample for local extensions |
| `examples/harbor/` | Disposable sample workspace |
| `.impeccable/` | Site brief and asset provenance |

Commands and gates are in [docs/development.md](docs/development.md).
Run `npm run verify` before calling a change done.

## Prefer maintained tools

Use trusted, maintained packages for solved problems. Reserve custom machinery
for ejm-ide's distinct behavior, its "secret sauce", and the thin adapters needed
to connect established tools.

Before adding infrastructure:

1. Check the platform, standard library, and existing project dependencies.
2. If none fits, evaluate established packages for maintenance, license,
   security, platform support, performance, and the required behavior.
3. Use the suitable package. Keep the adapter small and preserve its guarantees.
4. If custom infrastructure is needed, record the missing capability, the
   alternatives considered, and the reason in a nearby comment or design note.
   "Small", "simple", or "fewer dependencies" alone does not justify rebuilding
   a parser, transport, authentication flow, process runner, or UI interaction.

Apply this rule to existing code when touching it. Prioritize concrete bugs,
duplicate machinery, and missing guarantees. Preserve product behavior and
compatibility during replacements. Record remaining candidates in
[the codebase audit](docs/package-audit.md).

## Product UX

Start with the developer's intent and familiar choices. Reveal details after
those choices, show only relevant fields, and keep uncommon configuration under
Advanced. Use sensible defaults and one clear next action. Preserve non-secret
drafts and provide a clear way back or through errors.

Compact UI comes from clear hierarchy, fewer controls, and less repeated text.
Keep source readable, controls accessible, and complete details inspectable on
demand. Show actual capabilities and unavailable states honestly. Apply these
rules across setup, editor tools, chat, Git, debugging, and extensions. Use the
[UI skill](.agents/skills/ejm-ide-ui/SKILL.md) for specific interaction rules.

Place content by its purpose. Source, documents, diffs, and file previews belong
in the main editor, using one tab bar per editor group. Markdown preview follows
its file and live buffer. Keep execution, diagnostics, hierarchy, debugging, and
history in bottom tools; navigation and chat stay in sidebars. Keep actions
scoped to their content and put rare actions in menus. Preserve unsaved buffers,
keyboard access, and split/move behavior when reorganizing the workspace.

## Themes and brand

Every surface works in light and dark, and Preferences offers System, Light, and
Dark. Use theme tokens, never raw colors. The palette and rules come from the
ejmlabs design kit (`~/Desktop/ejmlabs/design-kit`). Read the
[theme skill](.agents/skills/ejm-ide-theme/SKILL.md) before changing a color.
Check visible changes in both themes. Do not type the ejmlabs wordmark; use the
kit's logo files.

## Ownership and product constraints

- Keep the agent loop, provider transport, and login machinery in ejm-harness
  and its auth package. Coordinate shared changes with the "ejmlabs harness" and
  "ejmlabs cli" sessions; keep this checkout's changes in IDE adapters. Do not
  edit `../ejm-harness`, `../ejm-cli`, or the design kit without asking their owners. Document parity gaps before
  retaining a temporary local implementation.
- Keep source editing and navigation primary. Use compact chrome, familiar IDE
  interactions, and accessible primitives. Keep code readable at its chosen size.
- Auto-review is the only review policy. Do not add Ask/Edit modes or a policy picker.
- Keep tool calls, file diffs, context, usage, errors, and diagnostic content
  inspectable. Label missing data, estimates, redaction, and retention limits.
- Use local fixtures for automated provider checks. Do not make paid model calls
  as part of tests. Never put credentials in fixtures, logs, or documentation.
- Run formatting, lint, type checks, and relevant behavior checks. See
  [docs/development.md](docs/development.md) for commands and shared-crate gates.
- Preserve unrelated edits. Never use em dashes. Follow Orwell's rules: use
  familiar words, active verbs, and only the words the reader needs.

## Public distribution

The public site is ide.ejmlabs.com (see the
[website skill](.agents/skills/ejm-ide-website/SKILL.md) and
[release skill](.agents/skills/ejm-ide-release/SKILL.md)). Use Cloudflare for the public download site, release metadata, and installer
storage. Add GCP only when a concrete requirement cannot be served by Cloudflare.
Keep the website build separate from the desktop app and exclude local project
files, credentials, logs, and development artifacts from public assets.

Only expose downloads backed by verified release artifacts. Keep platform and
architecture choices explicit, publish checksums, and show unavailable states
honestly. Build and sign installers on native OS runners. Do not widen provider
login or shared harness ownership to implement distribution.

## OpenSpec

If this project has an `openspec/` directory, feature and bugfix work must use
the OpenSpec workflow: explore or clarify, propose, apply, update when plans
change, then archive and sync specs. Do not implement directly from a plain
request in such a project. If the directory is absent, work normally. Run
`openspec init` only when the user asks.
