// Check the public documentation contract against the emitted static build: the three guides, their navigation,
// headings, contents, links and the repository files they point at. Run `npm run site:build` first.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist, ids, loadRoute, localTarget, origin, repo } from './lib/built.mjs';

const docs = ['/docs/', '/docs/user-guide/', '/docs/developer-guide/'];
const sitemap = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
const home = loadRoute('/');

for (const route of docs) {
  const { document, html } = loadRoute(route);
  assert.ok(
    home.document.querySelector(`a[href="${route}"]`) ||
      home.document.querySelector('a[href="/docs/"]'),
    `Homepage must link the docs`,
  );
  assert.ok(sitemap.includes(`${origin}${route}`), `Sitemap must include ${route}`);
  assert.equal(document.querySelectorAll('h1').length, 1, `${route} needs one h1`);
  const pageIds = ids(document);
  assert.equal(new Set(pageIds).size, pageIds.length, `${route} has duplicate ids`);
  assert.ok(
    document.querySelector('main#main nav[aria-label="Documentation"]'),
    `${route} needs the documentation sidebar`,
  );
  assert.ok(
    document.querySelector(
      `nav[aria-label="Documentation"] a[aria-current="page"][href="${route}"]`,
    ),
    `${route} must mark itself current in the sidebar`,
  );
  assert.ok(
    document.querySelector('nav[aria-label="On this page"]'),
    `${route} needs a contents list`,
  );
  assert.ok(
    document.querySelector('nav[aria-label="Previous and next pages"]'),
    `${route} needs previous and next links`,
  );
  if (route !== '/docs/')
    assert.ok(
      document.querySelector('pre[role="region"][tabindex="0"]'),
      `${route} needs a keyboard-scrollable code block`,
    );
  assert.doesNotMatch(html, /\/design-kit\//, `${route} must not use the retired design kit`);

  let previous = 0;
  for (const h of document.querySelectorAll('main h1, main h2, main h3, main h4')) {
    const level = Number(h.tagName[1]);
    assert.ok(level <= previous + 1, `${route} skips a heading level at "${h.textContent.trim()}"`);
    previous = level;
  }
  for (const a of document.querySelectorAll('nav[aria-label="On this page"] a[href^="#"]')) {
    assert.ok(
      pageIds.includes(a.getAttribute('href').slice(1)),
      `${route} has a missing contents target ${a.getAttribute('href')}`,
    );
  }
  for (const a of document.querySelectorAll('[href], [src]')) {
    const href = a.getAttribute('href') ?? a.getAttribute('src');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('data:'))
      continue;
    const local = localTarget(href, route);
    if (local?.hash && local.target.endsWith('.html')) {
      assert.ok(
        ids(
          loadRoute(local.target.slice(dist.length).replace(/index\.html$/, '')).document,
        ).includes(local.hash),
        `Missing linked heading ${href} on ${route}`,
      );
    }
    const url = new URL(href, `${origin}${route}`);
    const prefix = '/ejmlabs/ejm-ide/blob/main/';
    if (url.hostname === 'github.com' && url.pathname.startsWith(prefix)) {
      assert.ok(
        existsSync(join(repo, url.pathname.slice(prefix.length))),
        `Missing canonical source reference ${href} on ${route}`,
      );
    }
  }
  console.log(
    `ok ${route}: built route, headings, contents, navigation, links and source references`,
  );
}
