---
name: ejm-ide-website
description: Change, check, or deploy the public site at ide.ejmlabs.com. Use for its copy, layout, brand assets, screenshot, and Cloudflare Worker.
---

# Public site

The site is "ide" by ejmlabs, at `https://ide.ejmlabs.com`. It is static HTML
with a small TypeScript module, built by Vite from `website/` into
`website/dist`, and served by the Worker `ejmlabs-ide` (`distribution/`).

## Ownership

The IDE owns this site's content and composition. `ejm-ui` owns active shared
tokens, generated themes, reusable visuals, and site infrastructure through
public `@ejm/*` exports. Read [the shared-repository rules](../ejm-ide-shared-repos/SKILL.md)
before a shared change. These instructions do not install or publish those
packages.

For this readiness snapshot, start with [DESIGN.md](../../../DESIGN.md),
[website/index.html](../../../website/index.html), and the committed
[design-kit assets](../../../website/public/design-kit/). Read
[the site notices](../../../website/public/notices.txt) and keep both
[font licenses](../../../website/public/design-kit/fonts/). These retained files
support the asset snapshot and earlier references. Active shared UI changes
belong in `ejm-ui`.

The normal site build uses committed inputs. It needs no private brand checkout
or asset refresh. `website/scripts/sync-design-kit.sh` is an optional maintainer
refresh from a reviewed retained brand source. It replaces the committed copy;
use `DESIGN_KIT` to name that source explicitly, review the resulting diff, and
preserve its notices and provenance. Do not use this legacy refresh as a second
source for active shared tokens or primitives.

The sibling pages are cli.ejmlabs.com and harness.ejmlabs.com. Match their
anatomy and tone: header with the logo and product tag, a hero with an eyebrow,
one H1 and one action, a product figure, a feature grid, a split section, a
Forest band with a few honest numbers, a "get" section, and an Ink footer.

## Content rules

- Show the real app. Use a screenshot of the running app, never a mockup. Record
  its source, size, and SHA-256 in `.impeccable/download-site-assets.json`.
- Claim only what the docs back up. Numbers come from the project docs and are
  labelled as limits or measurements. Say what a number does not prove.
- Downloads stay honest. A platform shows "In development" until its signed
  installer is published. Never show a version or link that does not exist.
- Name the agent Edi and the program ejm-ide. See [the naming skill](../ejm-ide-naming/SKILL.md).
- No em dashes. One H1, ordered headings, alt text on every image, visible focus,
  a skip link, and reduced-motion support. Content reads without scripts.
- First load stays under 200 KB transferred. Measure the built result.

## Commands

| Command | Use |
| --- | --- |
| `npm run site:dev` | Vite dev server for the page |
| `npm run site:build` | Build into `website/dist` |
| `npm run site:check` | Types for the site and Worker |
| `npm run site:preview` | Worker plus assets on port 1423 (start it detached) |
| `npm run site:deploy` | Manual fallback only, when the owner asks: build, check, test, and `wrangler deploy` to production |

## Before merging

A merge to main deploys, so finish these first.

1. Build, check, and run `npm test` (the site's tests live beside the code).
2. Look at 320, 375, 768, and 1440 px, light and dark. Tab through the page.
3. Confirm `scrollWidth` equals `clientWidth` at 320 and 375.
4. Recapture the screenshot if the app's labels or theme changed.
5. Keep [the public download site guidance](../../../DESIGN.md#public-download-site)
   and [asset provenance](../../../.impeccable/download-site-assets.json) current.

## Deploy

A push to main deploys staging, then production. The pipeline, its failures, the
owner setup, and rollback are in
[the shared CI deploy reference](../ejmlabs-cloudflare/references/ci-deploys.md).
This site's facts:

- Production is the Worker `ejmlabs-ide` at `https://ide.ejmlabs.com`. Staging is
  `ejmlabs-ide-staging` at `https://staging.ide.ejmlabs.com`. Both read the R2
  bucket `ejmlabs-ide-releases`; neither writes to it.
- The config is `distribution/wrangler.jsonc`. The deploy takes the whole
  `distribution/` directory, which holds the Worker and its config, from the
  reviewed commit. The assets come from `website/dist`.
- Installer and manifest publishing (`distribution/publish.ts`) is separate from
  website deploys.
- Do not deploy from a workstation. `npm run site:deploy` is a manual fallback
  for when the owner asks. A local `--dry-run` is fine; the
  [dry-run commands](../../../docs/distribution.md#checks-manual-deploys-and-rollback)
  are in the distribution guide.
- Do not touch other Workers on the account (`gerry-marketing`,
  `gerry-coming-soon`, and others).

After each merge, when a deploy job finishes, request `/`, `/api/releases`,
`/editor.jpg`, a missing page (404), and the response headers on staging, then on
production. Load each in a browser and read the console.
