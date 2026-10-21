---
title: Developer guide
description: "Build and contribute to ejm-ide: repository layout, architecture, verification, tools, extensions, website, and releases."
lead: Build the app, explore the code and contribute a change. Follow the linked references for each subsystem.
group: Guides
---

## Set up a checkout {#setup}

The current native target is Apple Silicon macOS. Install Git, Node.js 24 LTS, stable Rust, Xcode Command Line Tools and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Keep the IDE, harness and shared UI repositories in the same parent directory. All three repositories are public; their metadata files select compatible shared revisions.

```sh title="Check out the IDE and its pinned dependencies"
git clone https://github.com/ejmlabs/ejm-harness.git
git clone https://github.com/ejmlabs/ejm-ui.git
git clone https://github.com/ejmlabs/ejm-ide.git
cd ejm-ide
git -C ../ejm-harness checkout --detach "$(cat .github/harness-revision)"
git -C ../ejm-ui checkout --detach "$(node -p "require('./.github/ui-source.json').revision")"
npm --prefix ../ejm-ui ci --ignore-scripts
npm ci --ignore-scripts
rustup component add clippy rustfmt
npm run dev:desktop
```

The native host depends on the sibling `ejm-harness` and `ejm-harness-auth` crates through Cargo paths. The site uses public `@ejm/*` packages through npm `file:` dependencies. Keep the immutable pins, lockfiles and source APIs in agreement. A shared contract change needs checks in the owning repository and affected consumer.

```text title="Required sibling checkout layout"
workspace/
  ejm-ide/
    app/
    src-tauri/
    website/
  ejm-harness/
    crates/ejm-harness/
    crates/ejm-harness-auth/
  ejm-ui/
    packages/
```

`npm run dev` serves the frontend at `127.0.0.1:1420` with labelled read-only samples for native services. `npm run dev:desktop` starts Tauri with frontend reload and native watching disabled. Restart it for Rust changes. Use `npm run tauri dev` when you want native rebuilds.

## Native platforms {#platforms}

The current package configuration produces macOS app and DMG candidates for Apple Silicon. Source checks and browser previews do not establish a signed installer or support for another OS or CPU. Test the packaged app without a source checkout or dev server before publication. Cover saves, credentials, language tools, process cleanup, keyboard shortcuts, dialogs and unsaved editor close behavior in both themes.

Windows and Intel macOS need compatible resources and native acceptance. Linux remains unsupported while the locked GTK stack requires `glib` 0.18.5, covered by [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). A compatible dependency update and native checks are required. Runtime exploitability in the IDE has not been established. See the [dependency audit](https://github.com/ejmlabs/ejm-ide/blob/main/docs/package-audit.md#public-readiness-dependency-check) and [distribution gates](https://github.com/ejmlabs/ejm-ide/blob/main/docs/distribution.md).

Saved API keys use macOS Keychain or a named environment variable. ChatGPT sign-in uses the shared auth engine and its supplied private native file store. Keep secrets out of frontend state, diagnostic exports and fixtures. Preserve original credential records when diagnosing failures; browser samples cannot verify native storage, callback or recovery behavior.

## Explore the code {#architecture}

Table: Repository layout

| Path or package | Responsibility |
| --- | --- |
| `app/` | React UI, Monaco models, editor groups, context references, chat and trace presentation. |
| `src-tauri/` | Filesystem access, language processes, Git, terminal, index, provider adapters, tools and reviewed writes. |
| `ejm-harness` | Shared engine/session state, resource admission, tool and execution policy, canonical messages and events. |
| `ejm-harness-auth` | Native login, token exchange, renewal, rotation and sign-out mechanics through `AuthEngine` and its store contract. |
| `ejm-ui` | Tokens, themes, reusable visuals and public site, build, demo and capture packages. |
| `website/` | Authored public pages, guides, release status and site composition. |
| `distribution/` | Cloudflare Worker, release contracts, R2 adapter and verified installer publisher. |

Typed Tauri commands and events connect the UI and Rust host. Shared Monaco models preserve one buffer across split views; Git diffs use read-only models in the same group layout. Language servers provide semantic evidence; Tree-sitter and SQLite provide local indexed evidence labelled as inferred.

Read the [ownership rules](https://github.com/ejmlabs/ejm-ide/blob/main/AGENTS.md) and matching local skill before editing. Choose the owner and check its public API first. Keep editor UX, workspace tools, automatic review choices, Tauri commands and OS adapters in the IDE. Shared execution and auth mechanics belong in the harness. Shared visuals, tokens and site machinery belong in ejm-ui. Do not import private sibling files, copy shared implementations or create dependency cycles.

Document a temporary adapter's missing shared contract, upstream target, compatibility checks and removal condition. Preserve provider reasoning, usage and diagnostics until the shared API covers them. See [Architecture](https://github.com/ejmlabs/ejm-ide/blob/main/ARCHITECTURE.md), [Harness design](https://github.com/ejmlabs/ejm-ide/blob/main/docs/harness.md) and [Package audit](https://github.com/ejmlabs/ejm-ide/blob/main/docs/package-audit.md).

## Start a change {#changes}

1. Read the [project rules](https://github.com/ejmlabs/ejm-ide/blob/main/AGENTS.md), matching project skill and subsystem reference.
2. Use OpenSpec for features and bug fixes: explore or clarify, propose, apply, update the plan when needed, then sync and archive verified work.
3. Keep source editing and navigation primary. Preserve unsaved buffers, keyboard paths, themes, inspectable tool results and fixed automatic review.
4. Choose maintained packages that meet the security, compatibility and measured resource requirements. Define budgets for affected paths before claiming an improvement.
5. Update affected public docs and examples with the change. Add tests for meaningful behavior, contracts and concrete regression risks.

Name the program **ejm-ide** and its agent **Edi**. Stable API names remain compatibility contracts: `workbench_*` tools, `workbench.*` storage keys, `.workbench/extensions/` and `window.workbench`. A display-name change does not migrate those identifiers.

## Run checks {#verification}

Format and lint before the full gate. Keep Cargo concurrency within the machine's memory and disk budget.

```sh title="Format and run the full verification gate"
npm run format
npm run lint:fix
CARGO_BUILD_JOBS=2 npm run verify
```

Table: Verification commands

| Command | Coverage |
| --- | --- |
| `npm run format:check` | Biome formatting and rustfmt for the IDE package. |
| `npm run lint` | Biome rules and import order; warnings fail. |
| `npm run check` | Strict TypeScript. |
| `npm test` | Frontend and distribution fixtures. |
| `npm run lint:rust` | Clippy on all native targets with warnings denied. |
| `npm run test:rust` | Native tests with the locked dependency graph. |
| `npm run build` | TypeScript and production frontend build. |

`npm run verify` runs all rows in order. Automated checks use local fixtures or replay responses and must not make paid model calls. Dependency compilation does not run harness workspace tests. A shared-engine change needs its own formatting, strict Clippy and focused tests.

Installed language-server tests are ignored by default because they require external tools. Run them for language integration changes:

```sh title="Run installed language-server integration tests"
CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml --test language_servers -- --ignored --nocapture
```

Review visible changes in light and dark in the browser or native app as appropriate. Browser samples do not prove native writes, credentials, process cleanup or packaged-app behavior. For index acceptance setup and the full check list, use [Development checks](https://github.com/ejmlabs/ejm-ide/blob/main/docs/development.md).

## Change Edi tools {#tools}

Tools live in `src-tauri/src/agent_tools.rs` and `agent_tools/`. Turn setup and the prompt live in `src-tauri/src/agent.rs` and `agent/core.rs`. Chat records and presentation are IDE adapters; canonical execution stays in the harness.

- Keep closed schemas, workspace/chat/turn binding, argument and result limits, cancellation and acknowledgement checks.
- Updates require the exact saved version from `workbench_read_file`. Creates use `expectedVersion: null` and an existing parent folder.
- Every write needs separate automatic review and host revalidation. Rejection, timeout, stale source and invalid review leave the file unchanged. Do not retry writes automatically.
- Treat source, context, tool output and attachments as untrusted data. Keep credentials out of frontend state, logs, fixtures and exports.
- Update the prompt, [tool reference](https://github.com/ejmlabs/ejm-ide/blob/main/docs/agent-tools.md) and focused tests together. Existing tool names include `workbench_read_file` and `workbench_show_ui`. Edi has no shell or external-action tool.

Navigation uses one-based lines and UTF-16 columns. Agent file tools accept regular UTF-8 files up to 128 KiB within the captured workspace. The tool reference contains graph continuation, presentation payload and acknowledgement contracts.

## Build an extension {#extensions}

Open **Extensions**, create **Sample notebook**, then choose **Build and preview**. Enable the checked version; Reload activates a later checked build, Disable unloads it and Revert restores the prior enabled version. A failed build preserves the working version.

Source lives under `.workbench/extensions/<id>/`, with `extension.json`, an entry file, panel assets, `sdk.d.ts` and `SKILL.md`. The host provides React and React DOM. The fixed builder checks syntax, imports and paths without running extension build scripts; it does not perform TypeScript semantic checking.

Use `window.workbench` for explicit context, chat attachment, source navigation and declared commands. Capabilities are checked for each request. Panels run in an opaque-origin sandboxed iframe without network access. Node imports, network imports, source outside the extension and symlinks are rejected. Native capability changes require a desktop rebuild.

Read [Local extensions](https://github.com/ejmlabs/ejm-ide/blob/main/docs/extensions.md) and [the authoring skill](https://github.com/ejmlabs/ejm-ide/blob/main/extension-template/SKILL.md) before editing. A successful build does not grant extra runtime permissions.

## Maintain the site {#website}

Public docs are authored as Markdown in `website/content/index.md`, `website/content/user-guide.md`, and `website/content/developer-guide.md`. The Markdown guides in `docs/` and the root contributor guides are separate canonical references; the site links to them and its checks read them. Update affected public pages and source references together.

When behavior changes, update the relevant setup steps, examples, limits and recovery advice. Describe what a reader can use now, and identify anything that is still under development.

The site is a Vite and React project in `website/`, prerendered to static HTML by the ejm-ui `@ejm/ssg` package and built into `website/dist`. Do not edit that generated output. A build step (`website/scripts/build-docs.mjs`, using `@ejm/site/docs`) turns the three Markdown files into page data. Shared `@ejm/ui/docs` components render it; prose stays in the prerendered HTML, so neither the Markdown parser nor the guide text needs to ship in browser JavaScript. Syntax highlighting also runs at build time; shared Copy and tab controls remain interactive. The build records whether any guide has code inside a list or callout and imports the public rich block renderer only when needed. Simple guides use the smaller shared code and tabs path. Routes are listed in `website/src/site.tsx`; add each new page there, in the navigation, and in `website/static/sitemap.xml`. The home page and the download page share one release list module that reads `/api/releases` in the browser.

```sh title="Build and check the website locally"
npm run site:build
npm run site:check
npm run site:docs:check
npm run site:test
npm test
npm run site:preview
```

Rebuild before running `site:docs:check`; it checks the emitted routes, links, headings, assets, and source references. `site:check` checks site and Worker types. `site:test` parses every route for structure, voice, tool names, primary playback and passive controls, and budgets. Keep navigation, examples, generated content, and reference material in sync through this build. The preview serves the Worker and assets at `127.0.0.1:1423`. For only the static site, `npm run site:dev` uses port 1422 and proxies API and download requests to that Worker.

The home uses `LazyIdePreview` from `@ejm/demos/islands/ide-preview` as its primary product view, with `#try` on the playback wrapper. It loads when visible and plays a local example of source inspection, automatic review and boundary-test edits. Keep the small shared heading, source actions and existing anchors. Do not repeat the session below or preload an unused capture. External controls pause, resume or restart playback; the product surface stays read only. The compact disclosure outside it says: "Example session. Runs locally in your browser; no model connection." Reduced motion and scripts-off views show the completed result. Edi does not run tests in this example; the final message asks the developer to run them locally. Measure the initial route and visible player together against the unchanged JavaScript and CSS budgets.

When no installer is published, the first home action is **Watch the example**. Keep the public IDE, harness and UI source links direct, with compatible dependency revisions before build commands. Source builds do not establish installer availability or native platform acceptance.

The header's **Source** link opens the public repository. The footer and contribution section link directly to source, issues and contributor guidance.

The example's named workspace, editor and message regions accept keyboard focus for scrolling read-only content. Its native product buttons and inputs stay disabled. The built-site gate allows only those three named scroll areas and rejects other tab stops and enabled product actions.

Keep both Mac CPU choices explicit: the OS hint does not detect architecture. Release rows distinguish unverified, loading, failed and validated empty lists; only a validated list can claim an installer is unpublished.

The shared footer links [website privacy](https://ejmlabs.com/privacy/) alongside source and legal links. That policy covers website visits and the theme choice; native credentials and model traffic have separate storage and provider terms.

The home’s noninteractive index-limit facts also use the public `Static` boundary, imported for server rendering and development. The HTML retains those facts and their anchor while their rendering code stays out of the browser. Keep playback and release status outside that boundary. On client navigation to a page without retained static markup, the supported Static API reloads the route so the server supplies the complete page.

The public `@ejm/shots/ide` entry supplies the historical `ide/workspace-launch` capture: a dark native launch state before a model connection. The home does not load it. If a page uses a native image, consume its public `getShot` result through `ProductShot`, honor the themes in its metadata, and preload only an image the page displays. Keep original pixels and provenance in the shared package.

The site uses components and styles from the sibling `ejm-ui` checkout, linked by `file:` paths until the packages are published. Use the revision in `.github/ui-source.json` and install its locked dependencies with `npm ci --ignore-scripts`. Update its lockfile in the shared repository when dependencies change. In `website/src/styles.css`, import `@ejm/ui/styles-site.css`, then `@ejm/ui/styles-docs.css`; docs styles are opt-in and keep code and tables in their scrolling containers. Use `source(none)` on the first import; public style profiles own their Tailwind source sets. Do not add private sibling `@source` paths. The native-shaped recording imports `@ejm/demos/ide-preview.css`; that public profile includes its player styles. Do not add the broad legacy demo stylesheet. Use the shared `Hero`, `Brand`, `Button` and documentation components. Keep product copy, routes, release state and installer policy local. Add no page CSS and copy no design files into this repository; brand files come from `@ejm/tokens`. The retained icon in `docs/brand/` is for repository documents, not a site design source.

ejm-ui owns all website type, spacing, branding, themes, motion, controls and layout recipes. The site supplies content, routes, release data and accessible state. Use `SectionBody`, `Columns`, `MetricGrid`, `ContentFlow`, `Actions`, `Note`, `InlineLink` and release metadata parts from the public `@ejm/ui/layout/SiteContent` entry. Headers and footers take structured identity with the project mark and name. Section headings choose a semantic purpose; heroes share one entrance sequence and respect reduced motion. `@ejm/demos/ShowcaseFrame` owns playback width and disclosure placement. Add missing patterns to ejm-ui before using them here.

`ejmSite` validates authored site source during builds and development. It rejects local CSS rules or imports, inline styles, style elements, visual `className` values and unsupported visual overrides, with a source location and shared-owner guidance. Public shared CSS imports and the literal `Static className="contents"` structure remain available. Shared changes reach the local linked site on rebuild. Existing public bundles change only after publication.

Website brand assets come from the public tokens package through `ejmSite`. Native app icons keep their separate Tauri build and packaged-app checks.

Review direct routes, links, copy controls, keyboard navigation, and light and dark views at 320, 375, 768, and 1440 pixels. At narrow widths, page scroll width must equal client width; code and tables scroll inside their own boxes. The site checker's source and built-route checks complement this visual review.

The existing Cloudflare Worker serves static assets and reserves `/api/` and `/downloads/` for release routes, so the download page lives at `/download/`. Keep credentials, logs, fixtures, development files, and local projects out of public assets. Include affected docs and their checks in the normal release process. Maintainers deploy the built site with `npm run site:deploy`. After deployment, check the affected live routes, release list, playback assets and browser console. A local build does not publish the site.

## Prepare a release {#releases}

For a source version release, update `VERSION`, matching package metadata and dated `CHANGELOG.md` notes in a pull request. After it merges, a maintainer runs **Draft release** for that main commit and version, checks the draft and publishes it through the release workflow. A site-only update does not require a native installer release.

Source archives are not signed installers. Desktop artifacts need native builds, final-byte checksums, signing/notarization where relevant and packaged-app smoke checks. Current Tauri packaging targets macOS app and DMG. Unpublished platforms remain unavailable on the download page.

The distribution publisher dry-runs by default. It validates and snapshots installers, hashes them, uploads and verifies readback, archives the manifest and updates `releases/latest.json` last. Do not edit the live manifest by hand or publish a debug bundle. Read [Releases](https://github.com/ejmlabs/ejm-ide/blob/main/RELEASING.md) and [Distribution](https://github.com/ejmlabs/ejm-ide/blob/main/docs/distribution.md) for commands, access requirements and the release checklist.

## Contribute a change {#contributing}

Keep the PR small and report its result, checks and limits. Follow [Contributing](https://github.com/ejmlabs/ejm-ide/blob/main/CONTRIBUTING.md), the [code of conduct](https://github.com/ejmlabs/ejm-ide/blob/main/CODE_OF_CONDUCT.md) and the [security policy](https://github.com/ejmlabs/ejm-ide/blob/main/SECURITY.md).

The protected workflow requires a human maintainer's readiness and approval decisions for the exact current commit, Quality, repository standards and two independent AI reviews. Draft PRs are not admitted. Do not bypass these gates or use an Actions rerun to repeat admission. A shared UI pin must be accepted on protected `main` first; the site PR then checks against that trusted dependency revision.

## Source references {#references}

- [Development checks and CI layout](https://github.com/ejmlabs/ejm-ide/blob/main/docs/development.md)
- [Architecture](https://github.com/ejmlabs/ejm-ide/blob/main/ARCHITECTURE.md) and [interface design](https://github.com/ejmlabs/ejm-ide/blob/main/DESIGN.md)
- [Language support](https://github.com/ejmlabs/ejm-ide/blob/main/docs/languages.md) and [index and context](https://github.com/ejmlabs/ejm-ide/blob/main/docs/indexing.md)
- [Agent tools](https://github.com/ejmlabs/ejm-ide/blob/main/docs/agent-tools.md) and [harness, chat and Debug](https://github.com/ejmlabs/ejm-ide/blob/main/docs/harness.md)
- [Local extensions](https://github.com/ejmlabs/ejm-ide/blob/main/docs/extensions.md) and [package audit](https://github.com/ejmlabs/ejm-ide/blob/main/docs/package-audit.md)
- [Website and distribution](https://github.com/ejmlabs/ejm-ide/blob/main/docs/distribution.md) and [releases](https://github.com/ejmlabs/ejm-ide/blob/main/RELEASING.md)
