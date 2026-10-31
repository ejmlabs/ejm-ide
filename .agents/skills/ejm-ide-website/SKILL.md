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

A push to main runs `.github/workflows/deploy.yml`, the canonical caller of the
shared `ejmlabs/.github` workflow `deploy-site.yml`. It builds the site from that
main commit, runs `wrangler deploy --env staging` to the Worker
`ejmlabs-ide-staging` at `https://ide-staging.ejmlabs.com`, then deploys the same
files to `ejmlabs-ide` at `https://ide.ejmlabs.com` once staging succeeds. No one
approves a deploy; the merge is the human decision. Deploy jobs run the Wrangler
that the shared repository pins (4.153.0 at the current pin), with the
`CLOUDFLARE_API_TOKEN` secret of the `staging` and `production` GitHub
environments, so CI deploys need no `wrangler login`. Do not deploy from a
workstation except through the `site:deploy` manual fallback when the owner asks;
a local `--dry-run` is fine. Staging binds the same R2 bucket
`ejmlabs-ide-releases`, which the Worker only reads. Installer and manifest
publishing (`distribution/publish.ts`) is unchanged and separate.

If a run stops before Wrangler runs, read the failing step. A missing
environment, branch policy or token means the owner has not finished the setup in
[Before the first deploy](../../../docs/distribution.md#before-the-first-deploy).
Report it. Do not create environments, secrets or tokens.

After each merge, when the run finishes, request `/`, `/api/releases`,
`/editor.jpg`, a missing page (404), and the response headers on staging and then
on production, load each in a browser, and read the console. Keep the commit SHA
and the Worker version ID from the job log. To roll back, redeploy an earlier
Worker version in Cloudflare, or revert on main. Do not touch other Workers on
the account (`gerry-marketing`, `gerry-coming-soon`, and others).
