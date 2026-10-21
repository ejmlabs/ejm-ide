// Shared by the site checks: read the built routes of website/dist and parse them with linkedom. Nothing runs a script.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

export const repo = fileURLToPath(new URL('../../..', import.meta.url));
export const dist = join(repo, 'website/dist');
export const origin = 'https://ide.ejmlabs.com';
/** Every page the site prerenders. The 404 page is written as 404.html. */
export const routes = ['/', '/download/', '/docs/', '/docs/user-guide/', '/docs/developer-guide/'];

export const fileOf = (pathname) =>
  join(dist, pathname.endsWith('/') ? `${pathname}index.html` : pathname);

export function loadRoute(route) {
  const file = route === '404' ? join(dist, '404.html') : fileOf(route);
  if (!existsSync(file))
    throw new Error(`Missing built page ${route}. Build the site with npm run site:build first.`);
  const html = readFileSync(file, 'utf8');
  return { route, html, document: parseHTML(html).document };
}

export const ids = (document) =>
  [...document.querySelectorAll('[id]')].map((n) => n.getAttribute('id'));

/** Resolve a link found on `route` to a file in dist (null for other origins). Returns { target, hash } or throws. */
export function localTarget(href, route) {
  const url = new URL(href.replaceAll('&amp;', '&'), `${origin}${route === '404' ? '/' : route}`);
  if (url.origin !== origin) return null;
  const target = resolve(fileOf(decodeURIComponent(url.pathname)));
  if (!target.startsWith(`${dist}/`)) throw new Error(`Link leaves the build: ${href}`);
  if (!existsSync(target) || !statSync(target).isFile())
    throw new Error(`Missing built file for ${href} on ${route}`);
  return { target, hash: decodeURIComponent(url.hash.slice(1)) };
}
