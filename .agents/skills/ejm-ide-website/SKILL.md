---
name: ejm-ide-website
description: Change, check, or deploy the public site at ide.ejmlabs.com. Use for its copy, layout, brand assets, screenshot, and Cloudflare Worker.
---

# Public site

Apply the [minimal-copy rule](../../../AGENTS.md):
prefer a clear visual or no added content, and keep only the words needed
for meaning, access, decisions and recovery.

The site is "ide" by ejmlabs, at `https://ide.ejmlabs.com`. It is a Vite and React
project in `website/`, prerendered to static HTML by `@ejm/ssg` and built into
`website/dist`, then served by the Worker `ejmlabs-ide` (`distribution/`).

## Ownership

The `ejm-ui` repository (`../ejm-ui`) owns the design system: `@ejm/tokens`, `@ejm/ui`,
`@ejm/ssg`, `@ejm/site`, `@ejm/demos` and `@ejm/shots`, linked with `file:` paths until they are
published. Its `ADOPTION.md` and `QUALITY.md` are the rules. Read that repository's
instructions and coordinate shared changes within the user's authorized scope.
Build pages from its public layouts and docs parts,
add no CSS of your own, and copy no design files into this repository. Brand files come
from `@ejm/tokens` through the `ejmSite` plugin. Never type the ejmlabs wordmark.

The sibling sites are cli.ejmlabs.com and harness.ejmlabs.com; the footer links them
from the shared registry.

ejm-ui owns all website type, spacing, branding, themes, motion, controls and layout recipes. The site supplies content, routes, release data and accessible state. Use `SectionBody`, `Columns`, `MetricGrid`, `ContentFlow`, `Actions`, `Note`, `InlineLink` and release metadata parts from the public `@ejm/ui/layout/SiteContent` entry. Headers and footers take structured identity with the project mark and name. Section headings choose a semantic purpose; heroes share one entrance sequence and respect reduced motion. `@ejm/demos/ShowcaseFrame` owns playback width and disclosure placement. Add missing patterns to ejm-ui before using them here.

`ejmSite` validates authored site source during builds and development. It rejects local CSS rules or imports, inline styles, style elements, visual `className` values and unsupported visual overrides, with a source location and shared-owner guidance. Public shared CSS imports and the literal `Static className="contents"` structure remain available. Shared changes reach the local linked site on rebuild. Existing public bundles change only after publication.

## Public docs sources and checks

The IDE owns the authored guides in `website/content/*.md`. Each heading has an
explicit `{#id}` (the id is part of the URL), tables take a `Table: Caption` line, and
a quote that starts `**Note:**`, `**Tip:**` or `**Warning:**` becomes a callout.
`website/scripts/build-docs.mjs` turns them into `website/src/generated/` data with
`@ejm/site/docs` before every dev run and build. Shared `@ejm/ui/docs`
components render the data and keep prose in the static HTML, so neither the
Markdown parser nor long-form guide text ships to the browser.
Keep the guides aligned with the canonical repository references in `docs/` and the
root contributor guides. Use `Hero`, `Brand`, `Button` and the shared documentation layouts. Keep
`@ejm/ui/styles-docs.css` imported after `@ejm/ui/styles-site.css`
in `website/src/styles.css`. Use `source(none)` on the first import and add no private sibling `@source` paths. Docs styles
are opt-in and keep code and tables inside
their scrolling containers.

Routes are listed in `website/src/site.tsx`: `/`, `/download/`, `/docs/`,
`/docs/user-guide/`, `/docs/developer-guide/`. The Worker owns `/downloads/`, so the
download page is `/download/`. Add new routes there and update the navigation, homepage,
and `website/static/sitemap.xml` together. Never hand-edit the output. Run
`npm run site:build`, `npm run site:check`, `npm run site:docs:check`, and
`npm run site:test`. Review affected pages with `npm run site:preview`. A passing build
does not publish the site; verify authorized publication before claiming it live.

## Content rules

- Use `LazyIdePreview` from `@ejm/demos/islands/ide-preview` as the home’s
  primary product view, with `#try` on its playback wrapper. Preserve the small
  shared heading, introduction, source actions and anchors. Do not repeat the session
  in a lower band or load an unused screenshot or image preload. The example uses
  `rootMargin="0px"`, native themes and shared display geometry. Keep the product
  surface passive, with only external pause, resume and restart controls. Keep the
  compact disclosure outside it: "Example session. Runs locally in your browser;
  no model connection." Reduced motion and scripts-off views show the completed result.
  Use only tool names from `docs/agent-tools.md`; do not imply Edi has a shell tool or ran tests.
- The public `@ejm/shots/ide` entry supplies `ide/workspace-launch`, a historical dark native launch capture before a model connection. If a page uses it, consume its public `getShot` result through `ProductShot` and use only the themes in its metadata. Keep matching image preloads SSR-only. Keep original pixels and provenance in the shots owner. The homepage uses the recorded preview and loads no native image.
- Claim only what the docs back up. Numbers come from the project docs and are
  labelled as limits or measurements. Say what a number does not prove.
- Downloads stay honest. A platform shows "In development" until its signed
  installer is published. Never show a version or link that does not exist.
- Name the agent Edi and the program ejm-ide. See [the naming skill](../ejm-ide-naming/SKILL.md).
- No em dashes. One H1, ordered headings, alt text on every image, visible focus,
  a skip link, and reduced-motion support. Content reads without scripts.
- Describe ejm-ide as an MIT-licensed open-source project. Use concrete editor and project
  capabilities, source/build/contribution links and clear development limits. Remove one-person
  lab framing, repeated source-access warnings, internal handoff/review prose, slogans and invented adoption claims. Keep the public IDE, harness and UI source links direct. State compatible dependency revisions before build commands, and keep installer and platform limits explicit. Review every public route, metadata description and authored guide.
- Budgets are enforced by the build (`ejm-ssg budget`): JavaScript, CSS, fonts and HTML gzip
  limits set in `website/src/site.tsx`. Keep the limits unchanged; fix the owning shared profile or product composition if a gate fails.

## Commands

| Command | Use |
| --- | --- |
| `npm run site:dev` | Vite dev server for the site on port 1422 |
| `npm run site:build` | Build into `website/dist` |
| `npm run site:check` | Types for the site and Worker |
| `npm run site:test` | Parse every built route for structure, voice, tool names, and budgets |
| `npm run site:docs:check` | Check emitted docs routes, links, headings, and navigation after building |
| `npm run site:preview` | Worker plus assets on port 1423 (start it detached) |
| `npm run site:deploy` | Build, check, and `wrangler deploy` |

## Before deploying

1. Run `site:build`, `site:check`, `site:docs:check`, `site:test` and `npm test`. Keep the required native source gate separate and report its result.
2. Look at 320, 375, 768, and 1440 px, light and dark. Tab through the page.
3. Confirm `scrollWidth` equals `clientWidth` at 320 and 375.
4. Check the example against current app labels and themes; recapture reference images when needed.
5. Update `.impeccable/download-site-brief.md` and the asset provenance file.

Deploy needs the user's Cloudflare login (`wrangler` OAuth). If auth fails, ask
the user to run `wrangler login`; do not retry in a loop. After deploy, request
`/`, `/api/releases`, the activated playback asset URLs, a missing page (404), and the response
headers, then load the live URL in a browser and read the console. Operate only
on the `ejmlabs-ide` Worker and the resources in its project configuration.

## Package boundaries

Read the root [package boundaries](../../../AGENTS.md) before
this workflow. Keep authored product content and routes local; extend
shared site, build, demo, and capture behavior in ejm-ui.
Check the owner's public API first. Use public exports and the root dependency
direction, with no private sibling imports or copied shared implementations.
Plans and reviews record owner, public interface, downstream impact, and
owner/consumer contract checks. Temporary adapters follow the root gap and
removal rules.

## Small footprint and fast execution

Small footprint and fast execution are the primary engineering goals, within
correctness, security, and required behavior. Minimize memory, CPU, startup
time, latency, binary or bundle size, I/O, and dependency cost. Choose the
smallest suitable design and the fastest measured option for the real workload.
Avoid needless services, background work, allocations, copies, and
abstractions. Define budgets for affected paths and measure representative
workloads before claiming an improvement. Document trade-offs when speed and
footprint conflict, and justify any regression. Apply these goals to package
choice, tests, and cleanup.

## Use maintained packages

Do not handroll functionality when a trusted, maintained package already meets
the functional, security, footprint, and performance requirements. Check the
standard library, platform APIs, and existing dependencies first, then evaluate
established packages for maintenance, security, license, compatibility, and
measured resource cost. Use the smallest suitable option and keep custom code
to product-specific behavior and thin adapters. If none fits, document the
alternatives and unmet requirement with evidence before writing custom code. A
measured footprint or speed constraint can rule out a package; preference or
assumption cannot. Apply this rule to production code, tests, fixtures,
scripts, and tooling.

## Tests must earn their place

Every test must protect meaningful behavior, a project contract, or a concrete
regression risk. Do not add or keep tests that merely mirror implementation,
assert incidental wording or source shape, duplicate equivalent coverage, or
retest a dependency without protecting a project contract. If a test provides
no distinct protection, remove or replace it. Match test cost and scope to the
risk; a reversible, low-impact edit does not need a new test by default.

## Campground rule

Leave the area you touch better than you found it. Fix nearby defects, stale
guidance, dead code, and needless complexity when the improvement is safe,
relevant, and easy to verify. Keep cleanup within the task’s scope, preserve
behavior and unrelated work, and record larger follow-up work rather than
starting an unrelated rewrite.

## Keep public docs current, honest, and detailed

For every change, review the public docs site and update all affected
documentation in the same change. Keep it accurate, honest, and detailed enough
for users and contributors to use, operate, and extend the current product.
Cover relevant setup, configuration, workflows, APIs, examples, errors, limits,
and recovery. Distinguish planned, implemented, tested, and released behavior;
state verification, availability, security, and performance limits plainly.
Keep navigation, links, examples, generated content, and reference material in
sync through the existing docs build. Check the affected docs and include them
in the normal release process. If a change has no public docs impact, record
the reason in its summary. Do not claim the live site is updated without
verifying publication.
