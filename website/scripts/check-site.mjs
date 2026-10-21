// Parse every built route (no script runs) and check what a visitor and a search engine get: structure, head, links, voice,
// tool names and the ejm-ssg size budgets. Run `npm run site:build` first.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dist, loadRoute, localTarget, origin, repo, routes } from './lib/built.mjs';

const DASH = String.fromCharCode(0x2014);
// Keep community copy free of old lab framing and obsolete private-source caveats.
const VOICE = /one[ -]person[ -]lab|source is private|private repositor(?:y|ies)|\bstudio\b/i;
const verbs = /\b(?:workbench_)?(?:read|write|search|open|show|clear|highlight|code)_[a-z_]+\b/g;

const tools = new Set(
  [...readFileSync(join(repo, 'docs/agent-tools.md'), 'utf8').matchAll(/^\| `([a-z_]+)` \|/gm)].map(
    (m) => m[1],
  ),
);
assert.ok(tools.size >= 9, 'docs/agent-tools.md should list the agent tools');

/** Visible text: the document without scripts, styles and the visually hidden announcer. */
const proseOf = (document) =>
  document.body.innerHTML
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

for (const route of [...routes, '404']) {
  const { document, html } = loadRoute(route);
  const at = (msg) => `${route}: ${msg}`;
  const is404 = route === '404';

  assert.equal(document.querySelectorAll('h1').length, 1, at('needs exactly one h1'));
  assert.equal(document.querySelectorAll('main#main').length, 1, at('needs one main#main'));
  const firstLink = document.body.querySelector('a');
  assert.equal(
    firstLink?.getAttribute('href'),
    '#main',
    at('the skip link must be the first link'),
  );
  assert.ok(firstLink.classList.contains('skip-link'), at('the first link must be the skip link'));

  // Head: title, description, canonical (404 is noindex), social image, theme boot before any stylesheet, no inline script.
  assert.ok(document.title.trim(), at('needs a title'));
  assert.ok(
    document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim(),
    at('needs a description'),
  );
  if (is404)
    assert.match(
      document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '',
      /noindex/,
      at('404 must be noindex'),
    );
  else
    assert.equal(
      document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      `${origin}${route}`,
      at('canonical'),
    );
  assert.ok(
    document
      .querySelector('meta[property="og:image"]')
      ?.getAttribute('content')
      ?.endsWith('/social-card.png'),
    at('og:image'),
  );
  const head = [...document.head.children];
  const boot = document.querySelector('script[src="/theme-boot.js"]');
  assert.ok(
    boot && !boot.hasAttribute('defer') && !boot.hasAttribute('async'),
    at('theme-boot.js must be synchronous'),
  );
  assert.ok(
    head.indexOf(boot) < head.findIndex((n) => n.matches('link[rel="stylesheet"]')),
    at('theme boot must come before the stylesheet'),
  );
  for (const s of document.querySelectorAll('script'))
    assert.ok(s.getAttribute('src'), at('no inline scripts'));
  assert.doesNotMatch(
    html,
    /cloudflareinsights|data-cf-beacon/,
    at('the analytics beacon is added by script, never prerendered'),
  );

  // Header: the theme toggle is the last thing in the header tools, and the logo links home.
  const header = document.querySelector('header');
  const toggle = header.querySelector('button[aria-label^="Switch to"]');
  assert.ok(toggle, at('header needs the theme toggle'));
  const order = [...header.querySelectorAll('a, button, summary')];
  assert.equal(order.at(-1), toggle, at('the theme toggle must be last in the header'));
  assert.ok(
    header.querySelector('a[aria-label="ejm-ide home"][href="/"]'),
    at('the logo must link home'),
  );
  assert.ok(header.querySelector('nav[aria-label="Main"]'), at('header needs the main nav'));

  // Links: other origins are marked external, local links and anchors resolve, every image has alt text.
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^https?:\/\//.test(href) && !href.startsWith(origin))
      assert.match(
        a.getAttribute('rel') ?? '',
        /\bexternal\b/,
        at(`external link needs rel=external: ${href}`),
      );
    if (href.startsWith('#'))
      assert.ok(document.getElementById(href.slice(1)), at(`missing anchor ${href}`));
    else if (!/^(https?:|mailto:)/.test(href) || href.startsWith(origin)) localTarget(href, route);
  }
  for (const img of document.querySelectorAll('img'))
    assert.ok(img.hasAttribute('alt'), at('image without alt'));

  // Voice and marks.
  const prose = proseOf(document);
  assert.doesNotMatch(prose, VOICE, at(`voice: ${prose.match(VOICE)?.[0]}`));
  assert.ok(!html.includes(DASH), at('no em dashes'));
  for (const name of new Set(prose.match(verbs) ?? []))
    assert.ok(tools.has(name), at(`tool name ${name} is not in docs/agent-tools.md`));
  console.log(`ok ${route}`);
}

// The local example declares its execution boundary outside the passive product surface.
const home = loadRoute('/');
const hero = home.document.querySelector('main > section, main > div > section, main section');
const example = home.document.querySelector('#try');
assert.ok(hero.contains(example), 'the primary product view keeps the example anchor');
assert.equal(
  home.document.querySelectorAll('[data-showcase="ejm-ide"]').length,
  1,
  'the home contains one example session',
);
const playback = example.querySelector('[data-showcase="ejm-ide"]');
assert.ok(playback, 'the home uses the shared IDE playback frame');
const disclosure = [...example.querySelectorAll('p')]
  .filter((paragraph) => !playback.contains(paragraph))
  .map((paragraph) => paragraph.textContent)
  .join(' ');
assert.match(disclosure, /Example session/i, 'the example must identify its scripted session');
assert.match(disclosure, /locally in your browser/i, 'the execution stays in the browser');
assert.match(disclosure, /no model connection/i, 'the example must disclose no model connection');
const surface = playback.querySelector('[data-showcase-viewport]');
assert.ok(surface, 'the example has the shared native product viewport');
assert.equal(
  surface.querySelectorAll(
    'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="button"], [contenteditable]:not([contenteditable="false"])',
  ).length,
  0,
  'the product surface must not expose working inputs, links or expandable controls',
);
// Read-only workspace, source and message areas retain keyboard scrolling.
const scrollAreas = [
  '.ejm-ide-viewport[role="region"][aria-label="IDE workspace. Scroll horizontally to view the editor and assistant."][tabindex="0"]',
  'div.edi-code[role="tabpanel"][aria-label][aria-labelledby][tabindex="0"]',
  'div.edi-messages[role="log"][aria-label="Edi messages"][aria-live="off"][tabindex="0"]',
].map((selector) => {
  const matches = surface.querySelectorAll(selector);
  assert.equal(matches.length, 1, `the example needs one named read-only scroll area: ${selector}`);
  return matches[0];
});
const editorArea = scrollAreas[1];
const selectedTab = surface.querySelector('button[role="tab"][aria-selected="true"][disabled]');
assert.ok(
  selectedTab &&
    editorArea.getAttribute('aria-label').trim() &&
    editorArea.getAttribute('aria-labelledby') === selectedTab.id &&
    selectedTab.getAttribute('aria-controls') === editorArea.id &&
    selectedTab.id.endsWith(`-tab-${editorArea.getAttribute('aria-label')}`),
  'the read-only editor scroll area must be named by its selected disabled file tab',
);
for (const node of surface.querySelectorAll('[tabindex]:not([disabled])')) {
  assert.ok(
    Number(node.getAttribute('tabindex')) < 0 || scrollAreas.includes(node),
    'only the three named read-only scroll areas may be tab stops in the product surface',
  );
}
for (const label of ['Pause ejm-ide playback', 'Restart ejm-ide playback']) {
  const control = playback.querySelector(`button[aria-label="${label}"]`);
  assert.ok(control && !surface.contains(control), `${label} is outside the product surface`);
}
// Playback replaces the capture, so no unused image or image preload belongs in the home.
assert.equal(
  home.document.querySelectorAll('figure[data-shot]').length,
  0,
  'the primary playback must not be repeated by a product capture',
);
for (const preload of home.document.querySelectorAll('link[rel="preload"][as="image"]'))
  assert.ok(
    [...home.document.querySelectorAll('img')].some(
      (image) => image.getAttribute('src') === preload.getAttribute('href'),
    ),
    'the home must not preload an unused image',
  );

assert.doesNotMatch(
  home.html,
  /editor\.webp/,
  'the old browser preview is not shipped as the hero',
);

assert.ok(home.document.querySelector('#try'), 'the home page keeps #try');
assert.ok(home.document.querySelector('#get'), 'the home page keeps #get');

// Source files carry no em dash either.
const walk = (dir) =>
  readdirSync(dir).flatMap((n) =>
    statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)],
  );
for (const file of [
  ...walk(join(repo, 'website/src')),
  ...walk(join(repo, 'website/content')),
  ...walk(join(repo, 'website/scripts')),
]) {
  if (/\.(tsx?|mjs|md|css)$/.test(file) && !file.includes('/generated/'))
    assert.ok(!readFileSync(file, 'utf8').includes(DASH), `em dash in ${file}`);
}
for (const file of ['_headers', 'theme-boot.js', 'sitemap.xml', 'robots.txt', 'social-card.png'])
  assert.ok(existsSync(join(dist, file)), `dist/${file}`);
const headers = spawnSync(
  'node',
  [
    join(repo, 'node_modules/@ejm/site/bin/ejm-site-headers.mjs'),
    join(dist, '_headers'),
    '--check',
  ],
  { encoding: 'utf8' },
);
assert.equal(
  headers.status,
  0,
  `_headers is not the shared policy:\n${headers.stdout}${headers.stderr}`,
);

const budget = spawnSync(
  'node',
  [join(repo, 'node_modules/@ejm/ssg/bin/ejm-ssg.mjs'), 'budget', join(dist)],
  { cwd: repo, encoding: 'utf8' },
);
process.stdout.write(budget.stdout);
assert.equal(budget.status, 0, `size budget:\n${budget.stderr}`);
console.log('site checks passed');
