import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { all, attr, dist, first, ids, must, ORIGIN, pages, served, tag, text } from './html';

const site = pages();
const home = must(
  site.find((p) => p.route === '/'),
  'home page',
);

const anchors = ['try', 'editor', 'how', 'keys', 'languages', 'limits', 'models', 'get'];

describe('routes and files', () => {
  it('builds the home page and the 404 page', () => {
    expect(site.map((p) => p.route)).toEqual(['/', '/404']);
  });

  it('ships the shared files, the kept public files and nothing from the old kit', () => {
    for (const f of [
      '404.html',
      '_headers',
      'theme-boot.js',
      'favicon.svg',
      'favicon.ico',
      'apple-touch-icon.png',
      'site.webmanifest',
      'social-card.png',
      'Manrope-OFL.txt',
      'IBMPlexMono-OFL.txt',
      'editor.jpg',
      'license.txt',
      'notices.txt',
      'robots.txt',
      'sitemap.xml',
    ]) {
      expect(served(`/${f}`), f).toBeTruthy();
    }
    expect(readdirSync(dist).includes('design-kit')).toBe(false);
  });

  it('lists only the home page in the sitemap, and the sitemap in robots.txt', () => {
    const sitemap = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual([`${ORIGIN}/`]);
    expect(readFileSync(join(dist, 'robots.txt'), 'utf8')).toContain(
      `Sitemap: ${ORIGIN}/sitemap.xml`,
    );
  });
});

describe.each(site)('$route', (page) => {
  const { doc } = page;
  const body = first(doc, tag('body'));
  if (!body) throw new Error('page has no body');

  it('ends the header with the theme toggle', () => {
    const header = must(first(doc, tag('header')), 'header');
    const controls = all(header, (n) => n.tagName === 'a' || n.tagName === 'button');
    const last = must(controls.at(-1), 'header control');
    expect(last.tagName).toBe('button');
    expect(`${attr(last, 'aria-label') ?? ''} ${text(last)}`).toMatch(/theme/i);
  });

  it('has a title, a description, and a canonical URL on every page but the 404', () => {
    const title = text(must(first(doc, tag('title')), 'title')).trim();
    expect(title.length).toBeGreaterThan(3);
    const meta = (name: string) =>
      attr(
        must(
          first(doc, (n) => n.tagName === 'meta' && attr(n, 'name') === name),
          `meta ${name}`,
        ),
        'content',
      );
    if (page.route === '/404') {
      expect(meta('robots')).toContain('noindex');
    } else {
      const canonical = must(
        first(doc, (n) => n.tagName === 'link' && attr(n, 'rel') === 'canonical'),
        'canonical link',
      );
      expect(meta('description')?.length ?? 0).toBeGreaterThan(40);
      expect(attr(canonical, 'href')).toBe(`${ORIGIN}${page.route}`);
    }
  });

  it('loads the theme script from a file and has no inline script or style element', () => {
    const scripts = all(doc, tag('script'));
    expect(scripts.every((s) => attr(s, 'src'))).toBe(true);
    expect(attr(must(scripts[0], 'script'), 'src')).toBe('/theme-boot.js');
    expect(all(doc, tag('style'))).toHaveLength(0);
  });

  it('gives every image alt text and every local link and anchor a target', () => {
    for (const img of all(doc, tag('img')))
      expect(attr(img, 'alt'), attr(img, 'src')).toBeDefined();
    for (const a of all(doc, tag('a'))) {
      const href = attr(a, 'href');
      if (!href || /^(https?:|mailto:)/.test(href)) continue;
      if (href.startsWith('#')) {
        expect(
          ids(doc).has(decodeURIComponent(href.slice(1))),
          `${page.route} links to ${href}`,
        ).toBe(true);
        continue;
      }
      const url = new URL(href, `${ORIGIN}${page.route}`);
      // The Worker, not the static assets, answers these two routes.
      if (url.pathname === '/api/releases') continue;
      expect(served(url.pathname), `${page.route} links to ${href}`).toBeTruthy();
      if (url.hash && url.pathname === '/') {
        expect(ids(home.doc).has(url.hash.slice(1)), `${page.route} links to ${href}`).toBe(true);
      }
    }
  });

  it('uses no em dash', () => {
    expect(page.html).not.toContain('\u2014');
  });
});

describe('home page', () => {
  it('keeps every anchor of the old page', () => {
    for (const id of anchors) expect(ids(home.doc).has(id), id).toBe(true);
  });

  it('has one h1 and the section headings in order', () => {
    const main = must(first(home.doc, tag('main')), 'main');
    expect(all(main, tag('h1')).map((h) => text(h).trim())).toEqual([
      'ejm-ide keeps you in the code.',
    ]);
    expect(all(main, tag('h2')).map((h) => text(h).trim())).toEqual([
      'Try ejm-ide in your browser.',
      'The editor, with the agent beside it.',
      'Built around the code you write.',
      'Four shortcuts to start.',
      'Language servers do the reading.',
      'Honest about what it knows.',
      'Bring your own model.',
      'Get ejm-ide.',
      'Built on an open engine.',
    ]);
  });

  it('reads without scripts: the demo falls back to the static view and the editor shows its screenshot', () => {
    const demo = must(
      first(home.doc, (n) => attr(n, 'aria-label') === 'ejm-ide example'),
      'demo',
    );
    expect(text(demo)).toMatch(/Simulated/i);
    const shot = must(
      first(home.doc, (n) => n.tagName === 'img' && attr(n, 'src') === '/editor.jpg'),
      'editor screenshot',
    );
    expect(attr(shot, 'alt')).toMatch(/project tree/);
  });

  it('shows no installer and no download link before a release is published', () => {
    const rows = all(home.doc, (n) => n.tagName === 'tr').map((r) =>
      text(r).replace(/\s+/g, ' ').trim(),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        'macOS, Apple Silicon Installer not published yet In development',
        'macOS, Intel Installer not published yet In development',
        'Windows, 64-bit Installer not published yet In development',
        'Linux, 64-bit Installer not published yet In development',
      ]),
    );
    expect(
      all(home.doc, (n) => n.tagName === 'a' && !!attr(n, 'href')?.startsWith('/downloads/')),
    ).toHaveLength(0);
  });

  it('gives visitors without scripts the release list', () => {
    const noscript = all(home.doc, tag('noscript'));
    const links = noscript.flatMap((n) => all(n, tag('a'))).map((a) => attr(a, 'href'));
    expect(links).toContain('/api/releases');
  });

  it('keeps the fixed prose in the HTML and out of the scripts', () => {
    const scripts = readdirSync(join(dist, 'assets'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(dist, 'assets', f), 'utf8'))
      .join('\n');
    for (const phrase of [
      'Search finds files and commands',
      'Ruby LSP does not advertise call hierarchy',
    ]) {
      expect(home.html).toContain(phrase);
      expect(scripts).not.toContain(phrase);
    }
  });
});

describe('_headers', () => {
  const headers = readFileSync(join(dist, '_headers'), 'utf8');
  const csp = new Map(
    (/Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? '').split('; ').map((d) => {
      const [name = '', ...sources] = d.split(' ');
      return [name, sources] as const;
    }),
  );

  it('allows what the page needs: the same origin for the release list, scripts and images', () => {
    expect(csp.get('connect-src')).toContain("'self'");
    expect(csp.get('script-src')).toContain("'self'");
    expect(csp.get('img-src')).toContain("'self'");
  });

  it('allows no inline script, no eval and no third party except the analytics beacon', () => {
    expect(csp.get('script-src')).toEqual(["'self'", 'https://static.cloudflareinsights.com']);
    expect(csp.get('connect-src')).toEqual(["'self'", 'https://cloudflareinsights.com']);
    expect(headers).not.toContain("'unsafe-eval'");
    expect(csp.get('style-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'none'"]);
  });
});
