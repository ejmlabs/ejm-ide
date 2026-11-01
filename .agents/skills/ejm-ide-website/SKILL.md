---
name: ejm-ide-website
description: Change, check, or deploy the public site at ide.ejmlabs.com. Use for its copy, layout, brand assets, screenshot, and Cloudflare Worker.
---

# Public site

The site is "ide" by ejmlabs, at `https://ide.ejmlabs.com`. It is a prerendered
Vite and React site on the pinned `ejm-ui`, built from `website/` into
`website/dist` and served by the Worker `ejmlabs-ide` (`distribution/`). It is
built the same way as the ejm-cli site.

## Ownership

The IDE owns this site's content and composition. `ejm-ui` owns tokens, fonts,
logos, favicons, the social card, themes, components, the page head, the headers
and the page checks, through public `@ejm/*` exports. Read
[the shared-repository rules](../ejm-ide-shared-repos/SKILL.md) before a shared
change. The site has no CSS, `className` or `style` of its own and copies no kit
code: the build fails on them. When a pattern is missing, add it to `ejm-ui`,
then move the pin (`.github/ui-source.json`) in its own change.

`website/` is its own package (`website/package.json` and lockfile). It links the
checkout beside this one, `../ejm-ui`, with `file:` dependencies. Run
`npm ci --ignore-scripts` in `../ejm-ui` first. The desktop app's root install
needs neither. Use the same `ejm-ui` revision as the pin.

| Path | Holds |
| --- | --- |
| `website/src/site.tsx`, `shell.tsx` | Routes, head, header, footer |
| `website/src/pages/Home.tsx` | The page: `Hero`, then one `Section` per anchor |
| `website/src/pages/home.server.tsx` | Fixed prose, rendered with `Static` and kept out of the browser bundle |
| `website/src/Downloads.tsx`, `useReleases.ts`, `release.ts` | The live download list from `/api/releases` |
| `website/public/` | `editor.jpg`, `license.txt`, `notices.txt`, `robots.txt`, `sitemap.xml` |
| `website/tests/` | Checks of the built HTML and `_headers` |

Keep [the site notices](../../../website/public/notices.txt) with the font and
icon licenses. Do not hand-edit or keep a copy of `_headers`: it is generated
from the shared policy. To extend it, pass `headers.extra` to `ejmlabs()`.

The sibling pages are cli.ejmlabs.com and harness.ejmlabs.com. Keep the same
anatomy and tone: a hero with an eyebrow and one H1, a product demo, alternating
sections, a "get" section, and the shared footer.

## Content rules

- Show the real app. Use a screenshot of the running app, never a mockup. Record
  its source, size, and SHA-256 in `.impeccable/download-site-assets.json`.
- Claim only what the docs back up. Numbers come from the project docs and are
  labelled as limits or measurements. Say what a number does not prove.
- Downloads stay honest. A platform shows "In development" until its signed
  installer is published. Never show a version or link that does not exist.
- Name the agent Edi and the program ejm-ide. See [the naming skill](../ejm-ide-naming/SKILL.md).
- No em dashes. One H1, ordered headings, alt text on every image, visible focus,
  a skip link, and reduced-motion support. Content reads without scripts; the
  build checks the page rules.
- First load stays under 200 KB transferred. Measure the built result.

## Commands

| Command | Use |
| --- | --- |
| `npm run site:install` | Install the website's dependencies (`npm ci --ignore-scripts` in `website/`) |
| `npm run site:dev` | Vite dev server on port 1422. It proxies `/api/` and `/downloads/` to `npm run site:preview` on 1423 |
| `npm run site:build` | Install, then build into `website/dist` |
| `npm run site:check` | Install, then website types, build, `ejm-site-headers --check` and tests, then the Worker's types |
| `npm run site:preview` | Worker plus assets on port 1423 (start it detached) |
| `npm run site:deploy` | Manual fallback only, when the owner asks: build, check, test, and `wrangler deploy` to production |

`.github/site-build` is what the shared deploy runs. It installs `../ejm-ui`, then
runs `npm run site:build`. The Quality job runs `npm run site:check` and
`npm run site:build` with `../ejm-ui` installed.

## Before merging

A merge to main deploys, so finish these first.

1. Run `npm run site:check` and `npm run site:build`. The site's tests are in
   `website/` and run in `site:check`; the root `npm test` does not run them.
2. Look at 320, 375, 768, and 1440 px, light and dark. Tab through the page.
3. Confirm `scrollWidth` equals `clientWidth` at 320 and 375.
4. Recapture the screenshot if the app's labels or theme changed.
5. The CSP is the shared one from `@ejm/site`. Read `website/dist/_headers` when
   the pin moves, and compare it with the live headers after a deploy.
6. Keep [the public download site guidance](../../../DESIGN.md#public-download-site)
   and [asset provenance](../../../.impeccable/download-site-assets.json) current.

## Deploy

A push to main deploys staging, then production once a maintainer approves it. The
pipeline, its failures, the owner setup, and rollback are in
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
