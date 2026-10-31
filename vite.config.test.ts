import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import {
  MONACO_SANITIZER,
  MONACO_VENDORED_DOMPURIFY,
  monacoUsesPackagedDompurify,
} from './vite.config';

const monacoEsm = join(import.meta.dirname, 'node_modules/monaco-editor/esm');
const sanitizer = join(import.meta.dirname, 'node_modules', MONACO_SANITIZER);

function packageVersion(name: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, 'node_modules', name, 'package.json'), 'utf8'),
  );
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    throw new Error(`${name} has no package version`);
  }
  return String(manifest.version);
}

it('finds Monaco importing its vendored DOMPurify only from the sanitizer', () => {
  const importers = readdirSync(monacoEsm, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .filter((file) =>
      readFileSync(join(monacoEsm, file), 'utf8').includes('dompurify/dompurify.js'),
    )
    .map((file) => file.replaceAll('\\', '/'));

  expect(importers).toEqual(['vs/base/browser/domSanitize.js']);
  expect(readFileSync(sanitizer, 'utf8')).toContain(
    `import purify from '${MONACO_VENDORED_DOMPURIFY}';`,
  );
});

it('bundles the dompurify package instead of Monaco’s copy', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [monacoUsesPackagedDompurify()],
    build: { write: false, minify: false, lib: { entry: sanitizer, formats: ['es'] } },
  });
  const code = (Array.isArray(result) ? result : [result])
    .flatMap((bundle) => ('output' in bundle ? bundle.output : []))
    .flatMap((item) => (item.type === 'chunk' ? [item.code] : []))
    .join('\n');
  const versions = [...code.matchAll(/\.version = "(\d+\.\d+\.\d+)"/g)].map((match) => match[1]);

  expect(versions).toEqual([packageVersion('dompurify')]);
}, 60_000);
