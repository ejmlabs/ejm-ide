---
name: ejm-ide-website
description: Change, check, or deploy the public site at ide.ejmlabs.com. Use for its copy, layout, brand assets, screenshot, and Cloudflare Worker.
---

# Public site

The site is "ide" by ejmlabs, at `https://ide.ejmlabs.com`. It is static HTML
with a small TypeScript module, built by Vite from `website/` into
`website/dist`, and served by the Worker `ejmlabs-ide` (`distribution/`).

## Ownership

The ejmlabs design kit (`~/Desktop/ejmlabs/design-kit`) defines the page shell,
sections, components, and rules in its `SITES.md`. The "ejmlabs" session owns the
move of every product site onto the kit. Before restructuring the page or its
styles, check what that session has changed in `website/`. Do not edit
`website/public/design-kit/`; refresh it with `website/scripts/sync-design-kit.sh`.

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
| `npm run site:deploy` | Build, check, and `wrangler deploy` |

## Before deploying

1. Build, check, and run `npm test` (the site's tests live beside the code).
2. Look at 320, 375, 768, and 1440 px, light and dark. Tab through the page.
3. Confirm `scrollWidth` equals `clientWidth` at 320 and 375.
4. Recapture the screenshot if the app's labels or theme changed.
5. Update `.impeccable/download-site-brief.md` and the asset provenance file.

Deploy needs the user's Cloudflare login (`wrangler` OAuth). If auth fails, ask
the user to run `wrangler login`; do not retry in a loop. After deploy, request
`/`, `/api/releases`, `/editor.jpg`, a missing page (404), and the response
headers, then load the live URL in a browser and read the console. Do not touch
other Workers on the account (`gerry-marketing`, `gerry-coming-soon`, and others).
