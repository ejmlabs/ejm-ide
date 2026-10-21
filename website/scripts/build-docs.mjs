// Product guide order and output paths stay local. Shared docs packages own the
// Markdown dialect, data model and static-prose split.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDoc, splitDoc } from '@ejm/site/docs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pages = [
  { file: 'index.md', slug: '' },
  { file: 'user-guide.md', slug: 'user-guide' },
  { file: 'developer-guide.md', slug: 'developer-guide' },
];

const docs = pages.map(({ file, slug }) => {
  try {
    return parseDoc(readFileSync(`${root}content/${file}`, 'utf8'), {
      metadata: { slug },
      requireFrontMatter: true,
      requiredMetadata: ['title', 'description', 'lead', 'group'],
      requireExplicitIds: true,
    });
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
});

const out = `${root}src/generated`;
mkdirSync(out, { recursive: true });
let requiresRich = false;
for (const page of docs) {
  const { full, client, requiresRich: rich } = splitDoc(page);
  requiresRich ||= rich;
  const name = `${out}/docs-${page.slug || 'index'}`;
  writeFileSync(`${name}.json`, `${JSON.stringify(client)}\n`);
  writeFileSync(`${name}-full.json`, `${JSON.stringify(full)}\n`);
}
writeFileSync(`${out}/docs-build.ts`, `export const requiresRich = ${requiresRich};\n`);
const nav = docs.map(({ slug, group, title }) => ({
  href: slug ? `/docs/${slug}/` : '/docs/',
  group,
  title,
}));
writeFileSync(`${out}/docs-nav.json`, `${JSON.stringify(nav)}\n`);
console.log(
  `docs: ${docs.map((page) => `${page.slug || 'index'} (${page.sections.length} sections)`).join(', ')}`,
);
