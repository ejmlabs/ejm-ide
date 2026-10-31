# Maintained-package audit

Reviewed on October 18, 2026. The rule is enforced by [AGENTS.md](../AGENTS.md)
and the project [engineering](../.agents/skills/ejm-ide-engineering/SKILL.md)
and [UI](../.agents/skills/ejm-ide-ui/SKILL.md) skills. Extension template
and Harbor example skills carry the same rule within their sandbox contract.

## Scope and evidence

The source inventory at the start of this audit contained 101 app files
(55 production TypeScript/TSX, 33 tests, 13 CSS), 24 native Rust source modules,
two native integration-test files, seven extension-template files, and 13
non-generated Harbor example files. Review included package manifests,
lockfiles, TypeScript/Vite/Biome/shadcn configuration, Tauri configuration,
quality workflow, project docs, and the template and Harbor extension skills. Dependencies, generated
output, and build caches were excluded.

All production modules were covered. Tests were inspected where they define
contracts or support a finding. This was a package-use and architecture audit,
not an exhaustive test, vulnerability, license, or transitive-dependency audit.
Replacement candidates that need a new package still need a current upstream
maintenance and advisory check before adoption.

| Area | Established tools and custom boundary |
| --- | --- |
| Editor and languages | Monaco, Shiki, real language servers, VS Code language services; custom document synchronization and completion policy |
| UI and rich chat | React, Radix, resizable panels, React Flow, Dagre, Recharts, diff, unified/remark; custom IDE layout, context references, and chat records |
| Native platform | Tauri, Tokio, reqwest, url, cap-std/cap-fs-ext, ignore, git CLI; custom workspace policy, conflict handling, and bounded execution adapter |
| Index and graph | SQLite FTS5/BM25, Tree-sitter, recursive SQL; custom freshness proof, rank fusion, evidence labels, and graph reveal policy |
| Agent and providers | Shared ejm-harness; IDE review/tool/presentation adapters. Local provider parity gaps are listed below. |
| Debugger | tracing Registry/Layer and Aho-Corasick; custom bounded retention, causal projection, and inspectable content |
| Extensions and tooling | esbuild, host-approved React/DOM, Vite, TypeScript, Biome, rustfmt, Clippy; custom import/capability boundaries |
| Harbor examples | Ordinary language and standard-library examples. No new dependencies needed. |

## Changes from this review

- **Tracing:** uses `tracing` and `tracing-subscriber` Registry ancestry. The IDE
  projects records and bounds retention; it does not invent a tracing runtime.
- **Credential matching:** Aho-Corasick supplies multi-pattern matching. A narrow
  unfinished-prefix adapter remains because the package does not provide the
  required longest-match streaming snapshot behavior. The reason is beside it.
- **Formatter edits:** use installed `TextDocument.applyEdits` for ordering and
  application. Keep strict range validation. A narrow compatibility adapter
  clamps oversized columns before calling TextDocument 1.0.11 because that
  version can clamp an edit into the next line and remove its newline. Ordering
  and offset application remain with the package. Regressions cover insertion
  order, UTF-16, CRLF, and line boundaries.
- **Extension builds:** reuse `terminal::run_bounded` for process groups,
  deadlines, bounded output, and pipe draining. Remove the duplicate child and
  reader-thread lifecycle. Keep the 4 MiB bundle limit and 64 KiB displayed
  diagnostics; bounded stderr capture can reach 4 MiB before display slicing.
- **Shared API integration:** route canonical native OpenAI through the shared
  Responses provider and use `ejm-harness-auth` for ChatGPT login. Preserve per-call
  model/effort, tool replay, account binding, opaque continuation, and optional
  usage detail. Tool failure and artifact metadata survive storage and replay.
  The IDE supplies a bounded diagnostic projection with explicit interruption
  and omission markers.
- **Endpoint validation:** profiles and transport share one URL validator for
  TLS, loopback exceptions, and credential-free endpoints.

## Verification

The final IDE checks on October 18 passed against the verified, frozen shared
Rust contract:

- Biome formatting and strict lint; TypeScript; production frontend build.
- 461 frontend tests across 34 files.
- Rust package formatting and all-targets Clippy with warnings denied.
- 203 native unit tests and six workspace-integrity tests. Seven optional
  language-server/index acceptance checks remain ignored by the normal gate.
- Four project skills validate; all 20 local guidance links resolve.
- Browser preview inspection covered subscription controls, disabled native
  actions, and Escape dismissal. Live login and hosted inference were not run.

The shared owner separately reported 106 passing Rust tests, strict Clippy,
Rust builds/docs, and dependency checks. Its SDK timing gate and release
binaries are separate from this IDE's Rust-library verification.
The frontend build retains an existing large-chunk warning, about 5.48 MB
minified for the main chunk at that baseline. No dependency advisory or license
scan was run for the initial audit. The later command-palette check is recorded below.
A listed replacement does not mean every runtime path has been exercised.

## Command-palette follow-up

The UX pass replaced the custom command-menu interaction with cmdk 1.1.1 inside
Radix Dialog. It handles selected rows, arrows, Enter, and scrolling. ejm-ide keeps
file/context actions and the bounded result list. The registry declares MIT and
React 18/19 support. Its public `dip/cmdk` repository was not archived or disabled
when checked on October 18, 2026; the latest recorded push was October 29, 2025.
The package adds one installed dependency because its Radix dependencies were
already present. No cmdk advisory appeared in the current npm audit.

The npm audit reported three low-severity entries in the existing dependency
set: DOMPurify, Monaco through DOMPurify, and esbuild. These were not changed in
this UX pass. The main frontend chunk is now about 5.51 MB minified; the existing
large-chunk warning remains. Use [the interaction principles](../DESIGN.md#interaction-principles)
for current UX guidance and [development checks](development.md) for verification
commands.

## Editor tab and menu follow-up

Editor tab interaction now uses `@radix-ui/react-tabs` 1.2.1 and
`@radix-ui/react-context-menu` 2.4.1. Both declare MIT licenses and React 19 peer
support and come from the official `radix-ui/primitives` project. This reuses
established keyboard, selection, focus, and menu behavior while ejm-ide retains
its source/diff/preview identities, group reducer, and dirty-buffer protections.
The existing `react-resizable-panels` dependency still owns pane resizing.

The install added only these two packages. npm audit still reported the same
three low-severity entries listed above. This check does not establish that the
whole dependency tree has no advisories. See [editor groups and debug inspection](../DESIGN.md#editor-groups-and-debug-inspection)
for current interaction rules and [development checks](development.md) for
verification commands.

## Public-readiness dependency check

The October 18, 2026 dependency check resolved the reported npm advisories:

- Monaco remains at 0.57.0. A scoped override changes its DOMPurify dependency
  from 3.4.15 to 3.4.16, fixing GHSA-6688-9rhm-gjv2 and GHSA-p98j-92pf-mc4p.
- esbuild changes from 0.27.7 to 0.28.1, fixing GHSA-g7r4-m6w7-qqqr. Vite
  8.3.4 already accepts this esbuild line. Its version stays unchanged.

A complete `npm audit --package-lock-only` returned zero known npm
vulnerabilities under Node.js 24.19.0. The lock retains matching esbuild
platform packages. npm also recorded six dependencies already bundled in the
unchanged Tailwind WASM package; no unrelated package version changed.

The extension host calls esbuild's build API, not its development server.
Moving between esbuild 0.x minor versions still needs the real extension
template regression and frontend build at the next full gate. This lock-only
check did not install packages or establish browser or packaged-app acceptance.

The native Cargo lock still includes glib 0.18.5 through the Linux GTK stack,
with unresolved advisory RUSTSEC-2024-0429. The supported target is macOS on
Apple Silicon, whose resolved dependency tree does not include this crate.
Linux remains unsupported. Its release gate requires a compatible Tauri/GTK
upgrade to a fixed glib version and native verification. GTK 0.18 requires
glib 0.18, so forcing a glib 0.20 override is not a compatible fix.

## Dependency alert fixes, October 31, 2026

A complete `npm audit --package-lock-only` and `cargo audit` on `src-tauri/Cargo.lock`
found these advisories. Each fix is the smallest bump that clears it. The 14-day age
rule yields to a security fix.

- undici 7.29.1 to 7.30.1 (published October 15) fixes eight advisories, among them
  GHSA-2m5v-pch6-74hx, GHSA-4w7w-5xrc-9h26, GHSA-qrxm-fqhp-jwvm and
  GHSA-xjj6-f33q-929c (high). Miniflare pins undici exactly, so wrangler moves from
  4.151.3 to 4.153.0 (October 26), the first release whose miniflare pins 7.30.1. This is
  development tooling for the site Worker; nothing from it reaches the app or the site
  bundle.
- The DOMPurify override moves from 3.4.16 to 3.4.17 (published October 12) for
  GHSA-cg2g-xh64-v4q7 (critical), GHSA-mrv2-3pqr-j5jr (high) and GHSA-c6gr-qvv4-5v3f
  (low). monaco-editor 0.57.0 imports its own copy of DOMPurify 3.4.15
  (`esm/vs/base/browser/dompurify/dompurify.js`) from `domSanitize.js`, so the override
  alone left that copy in the built app. A resolver plugin in `vite.config.ts` points that
  one import at the dompurify package, for the build and the dev server's dependency
  optimizer, so the app bundles the version the override pins. `vite.config.test.ts`
  builds the sanitizer and fails if Monaco imports its copy from anywhere else or the
  bundle holds another version. Monaco's own sanitize calls set none of `IN_PLACE`,
  `SAFE_FOR_TEMPLATES` or `PARSER_MEDIA_TYPE`, which the three advisory titles name, and
  no installer has shipped the old copy. Drop the plugin once a Monaco release imports
  the dompurify package itself.
- Cargo: pulldown-cmark 0.13.4 to 0.13.5 (RUSTSEC-2026-0414, wikilinks, an option this
  app does not enable), rustls-webpki 0.103.15 to 0.103.16 (RUSTSEC-2026-0382) and
  webpki-root-certs 1.0.9 to 1.0.10 (RUSTSEC-2026-0383), and ctutils 0.4.3 to 0.4.4
  (RUSTSEC-2026-0385). Only pulldown-cmark and rustls-webpki are in the macOS tree. The
  re-resolve also moved `cssparser-macros` to syn 2 and tempfile to getrandom 0.3.4, both
  already in the lock and allowed by those crates.

`cargo audit` now reports no vulnerability. Its warnings remain: glib 0.18.5 (see above)
and the unmaintained proc-macro-error, zbus_names, zvariant and zvariant_derive. Cargo's
resolved tree for macOS includes none of the five.

## Remaining candidates

| Priority | Location | Action and condition |
| --- | --- | --- |
| Medium | `src-tauri/src/providers/driver.rs` | Replace the SSE BOM/chunk workaround with a maintained bounded parser. The shared harness uses `sse-core`; retain total-stream, event, and output budgets. |
| Medium | `src-tauri/src/providers/profiles.rs` | Use `tempfile` for private configuration staging. Preserve 0600, sync-before-rename, parent-directory sync, and old-credential retirement order. |
| Medium | `src-tauri/src/providers/driver_tests.rs` | Use a maintained HTTP fixture server for ordinary responses, discovery, and errors. Keep raw-byte fixtures only where transport bytes are under test. Bound accept waits. |
| Medium | `src-tauri/src/terminal.rs` | Replace raw `libc` fcntl/process-group wrappers with safe maintained APIs such as compatible `rustix`. Preserve group termination, timeouts, and bounded drains. |
| Medium | `src-tauri/src/index.rs` | Evaluate the installed grammar crates' `TAGS_QUERY` with Tree-sitter Query/QueryCursor. Keep scope, source-version proof, and inferred/ambiguous labels. Tags are not a complete semantic call resolver. |
| Medium | `src-tauri/src/index/traversal.rs` | Use standard HMAC and constant-time verification if continuation signatures remain an integrity boundary. Select compatible digest versions. The review did not establish an exploit. |
| Medium | `src-tauri/src/extensions.rs` | Use `tempfile` for private build staging where it preserves confinement and persistence. Do not replace descriptor-relative workspace writes with path-only temporary files. |
| Later | `app/components/AgentPresentation.tsx` | Replace manual floating geometry/observers with a supported Radix virtual anchor or a direct maintained positioning dependency. |
| Later | `app/components/FileTree.tsx` | Use a maintained accessible tree primitive when adding keyboard navigation or virtualization. Keep lazy directory loading. |
| Later | `src-tauri/src/agent_tools.rs` | Use Tokio Semaphore/OwnedSemaphorePermit for admission. Keep permits inside blocking workers until the work actually ends. |
| Later | `src-tauri/src/agent.rs` | Prefer CancellationToken wakeups to clonable Notify-based cancellation. Preserve synchronous write checks. |
| Later | `src-tauri/src/agent_tools/ide.rs` | Share schema generation/structural validation with canonical typed contracts. Keep byte limits and semantic checks for IDs, columns, series, and graph endpoints. |
| Measured migration | `src-tauri/src/lsp.rs` and `language.rs` | Evaluate maintained LSP client transport/types. Preserve framing bounds, pending-request limits, cancellation, Ruby quirks, and workspace security. Do not use a server framework as a client. |

### Provider parity boundary

The synced shared Responses provider supports per-call model/effort, credential
sources, HTTP observation, optional usage detail, and encrypted continuation.
The shared Chat Completions and Anthropic adapters do not yet cover every IDE
contract: per-call reasoning options, DeepSeek `reasoning_content` replay,
Anthropic signed thinking blocks, detailed cache accounting, and HTTP observation.
Coordinate those gaps with "ejmlabs cli" before deleting the local adapters.
Keep existing contract tests while migrating. A smaller implementation that
loses those guarantees does not meet the package rule.

### Deliberate custom code

Keep ejm-ide's context references, source freshness, semantic evidence, graph
paging, editor-group reducers, review decisions, capability rules, chat schema,
repair and retention policy over SQLite, and trace presentation. These compose
maintained tools and encode product behavior. Keep git porcelain parsing as a thin CLI adapter for now;
replacing the installed git CLI with another repository engine has no proven
benefit for the current task. Do not add packages just to replace a short mapper
or a small extraction mapper over a maintained parser.
