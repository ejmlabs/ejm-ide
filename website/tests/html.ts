// Reads the built site. Pages are parsed with parse5 and never executed, so what is checked is what a visitor gets before any script runs.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

// fileURLToPath, not .pathname, so a checkout under a folder with a space or another escaped character still resolves.
export const root = fileURLToPath(new URL('..', import.meta.url));
export const dist = join(root, 'dist');
export const ORIGIN = 'https://ide.ejmlabs.com';

// parse5 nodes, typed loosely on purpose: the helpers below are all the tests use.
export interface Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
}

export const attr = (n: Node, name: string) => n.attrs?.find((a) => a.name === name)?.value;
const kids = (n: Node) => (n.content ? (n.content.childNodes ?? []) : (n.childNodes ?? []));

function walk(n: Node, visit: (n: Node) => void) {
  visit(n);
  for (const c of kids(n)) walk(c, visit);
}
export const all = (n: Node, pred: (n: Node) => boolean) => {
  const out: Node[] = [];
  walk(n, (x) => pred(x) && out.push(x));
  return out;
};
/** The value, or a failure that names what is missing. Tests use it instead of a non-null assertion. */
export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`The built page has no ${what}`);
  return value;
}
export const tag = (name: string) => (n: Node) => n.tagName === name;
export const first = (n: Node, pred: (n: Node) => boolean) => all(n, pred)[0];

/** Visible text of a subtree. Script, style and svg are left out. A `noscript` is included: it is what a visitor without scripts reads. */
export function text(n: Node): string {
  if (n.nodeName === '#text') return n.value ?? '';
  if (n.tagName === 'script' || n.tagName === 'style' || n.tagName === 'svg') return '';
  return kids(n)
    .map((c) => text(c))
    .join(/^(p|li|tr|td|th|h\d)$/.test(n.tagName ?? '') ? ' ' : '');
}

export interface Page {
  route: string;
  file: string;
  doc: Node;
  html: string;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Every HTML file of the build as a route (`/`), plus the 404 page. Parsed as a browser with scripts off would, so `noscript` content is elements. */
export function pages(): Page[] {
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error('website/dist is missing: run `npm run build` in website first');
  }
  return files(dist)
    .filter((f) => f.endsWith('.html'))
    .map((file) => {
      const rel = relative(dist, file).split('\\').join('/');
      const route =
        rel === '404.html'
          ? '/404'
          : rel === 'index.html'
            ? '/'
            : `/${rel.replace(/index\.html$/, '')}`;
      const html = readFileSync(file, 'utf8');
      return {
        route,
        file,
        html,
        doc: parse(html, { scriptingEnabled: false }) as unknown as Node,
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route));
}

/** The file a local URL path is served from, or undefined. */
export function served(path: string): string | undefined {
  const clean = decodeURIComponent(path.split(/[?#]/)[0] ?? '');
  for (const c of [join(dist, clean), join(dist, clean, 'index.html')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return undefined;
}

export const ids = (doc: Node) =>
  new Set(all(doc, (n) => !!attr(n, 'id')).map((n) => attr(n, 'id') as string));
