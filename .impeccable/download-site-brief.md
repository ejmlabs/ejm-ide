# ide by ejmlabs download site

Surface: website/index.html, website/src/main.ts, website/src/site.css.
Public URL: https://ide.ejmlabs.com/
Audience: developers considering a free desktop IDE.
The page explains the editor's human-coding focus and helps people find their
platform download.

## Brand authority

The public product name is "ide", by ejmlabs. Use the ejmlabs design kit 1.0.0
at `/Users/everettmorgan/Desktop/ejmlabs/design-kit`. Read its `README.md`,
`tokens/brand.css`, and `REVIEW.md`. The sibling sites cli.ejmlabs.com and
harness.ejmlabs.com use the same kit; keep the family consistent.

- Palette: Paper `#f6f5ef`, Ink `#202721`, Forest `#29443b`, Sage `#8a9a7b`,
  Mist `#e8ede3`. Read text only in approved pairs: Ink on Paper, Paper on
  Forest, Forest on Mist. Sage is artwork, never small text on Paper. Dark mode
  uses the ejmlabs.com deep-space `#02070d` with Paper text.
- Type: Manrope 400 body and 600 headings; IBM Plex Mono 500 for eyebrows,
  versions, statuses, and short labels. Fonts are self-hosted Latin WOFF2
  subsets of the kit files with their OFL licenses.
- Layout: mirrors cli.ejmlabs.com. Header, hero with a cropped Sage symbol,
  product figure, six-cell feature grid, split section, full-bleed Forest band
  with four stats and a methodology note, provider grid, "Get" section, and an
  Ink footer. Dark mode uses Ink as the page color. Keep its lessons: figures
  need auto side margins, grid children need min-width 0, and scrollWidth must
  equal clientWidth at 320 and 375 px.
- Lockup: the full ejmlabs logo followed by the product name in an outlined
  mono tag, as on cli.ejmlabs.com. Never retype the ejmlabs wordmark. The logo
  file `brand/ejmlabs-logo.svg` is the kit's primary logo with recolorable
  fills; its paths are unchanged.
- Graphic language: a cropped Sage symbol behind the hero, a Forest band for
  downloads, and the signature "Small experiments. Useful things." in the footer.

The ejmlabs name and logo are the owner's artwork. The IDE's MIT license does
not grant rights to them.

## Content and technical boundaries

Show the real app and describe verified capabilities. Keep one main download
action, explicit platform choices, and clear availability. The provider's terms
and charges apply to AI use, even though the IDE is free. Native build runners
must create and sign platform installers before downloads appear. Do not publish
a debug bundle or suggest that an absent release is ready.

The site uses static HTML and small native TypeScript modules through Vite.
Lucide interface icons are rendered at build time. Cloudflare Static Assets
through the `ejmlabs-ide` Worker serves the page, with private R2 release
storage (`ejmlabs-ide-releases`) and public verified release metadata. Do not
expose local project files or credentials.

Keep no more than eight sections, one H1, a main landmark, a skip link, visible
focus, labelled controls, reduced-motion support, canonical and social
metadata, a sitemap, robots file, and a 404 page. Keep content readable without
scripts. Target under 200 KB for the first page load and measure the built
result. Check 320 px, phone, and desktop widths, light and dark themes, keyboard
paths, release failures, and unavailable states before publishing.

## Asset provenance

`website/public/editor.jpg` is a headless Chrome capture of the actual
rebranded app's browser preview on 18 October 2026, in dark theme, using the
built-in Harbor sample. No generated product mockup is used. The social card and touch icon are unchanged kit exports. Hashes and
sources are in `.impeccable/download-site-assets.json`.

Band stats come from docs/languages.md and are limits, not measurements. The
program is named ejm-ide; the page lockup reads "ide" by ejmlabs. Rust crate
and package names still follow the harness migration.
