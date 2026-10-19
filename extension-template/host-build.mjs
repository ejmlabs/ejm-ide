// This trusted driver is shipped with the host, never read from an extension.

import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(runtimeRoot, 'package.json'));
const esbuild = require('esbuild');

function within(root, path) {
  const part = relative(root, path);
  return part === '' || (!part.startsWith('..') && !isAbsolute(part));
}

async function buildExtension(source, entry) {
  const root = await realpath(source);
  const packages = await Promise.all(
    ['react', 'react-dom', 'scheduler'].map(async (name) =>
      dirname(await realpath(require.resolve(`${name}/package.json`))),
    ),
  );
  const roots = [root, ...packages];
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [resolve(root, entry)],
    bundle: true,
    write: false,
    outfile: 'panel.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
    nodePaths: [resolve(runtimeRoot, 'node_modules')],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
    plugins: [
      {
        name: 'extension-boundary',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData?.resolvedByHost) return;
            const resolved = await builder.resolve(args.path, {
              kind: args.kind,
              resolveDir: args.resolveDir || root,
              importer: args.importer,
              pluginData: { resolvedByHost: true },
            });
            if (resolved.errors.length) return { errors: resolved.errors };
            if (resolved.external || resolved.namespace !== 'file')
              return {
                errors: [
                  { text: 'Only local extension files and bundled React packages are supported.' },
                ],
              };
            const path = await realpath(resolved.path);
            if (!roots.some((allowed) => within(allowed, path)))
              return {
                errors: [
                  {
                    text: `Import is outside the extension and bundled React packages: ${args.path}`,
                  },
                ],
              };
            return { path };
          });
          builder.onLoad({ filter: /.*/ }, async (args) => {
            const path = await realpath(args.path);
            if (!roots.some((allowed) => within(allowed, path)))
              return { errors: [{ text: 'Source moved outside its allowed directory.' }] };
            const bytes = await readFile(path);
            if (bytes.length > 2 * 1024 * 1024)
              return { errors: [{ text: 'Imported file exceeds the 2 MiB limit.' }] };
            const loaders = {
              '.js': 'js',
              '.mjs': 'js',
              '.cjs': 'js',
              '.jsx': 'jsx',
              '.ts': 'ts',
              '.tsx': 'tsx',
              '.json': 'json',
              '.css': 'css',
              '.svg': 'dataurl',
              '.png': 'dataurl',
              '.woff2': 'dataurl',
            };
            const loader = loaders[extname(path)];
            if (!loader)
              return {
                errors: [{ text: 'This file type is not supported in an extension panel.' }],
              };
            return { contents: bytes, loader, resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  const code = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text;
  if (!code) throw new Error('The extension did not produce JavaScript.');
  const css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text || '';
  if (code.length + css.length > 3 * 1024 * 1024)
    throw new Error('The built panel exceeds the 3 MiB limit.');
  return { code, css, files: Object.keys(result.metafile.inputs).length };
}

try {
  const [source, entry] = process.argv.slice(2);
  if (!source || !entry) throw new Error('Expected extension directory and entry point.');
  process.stdout.write(JSON.stringify(await buildExtension(source, entry)));
} catch (error) {
  process.stderr.write(String(error?.message || error).slice(0, 12000));
  process.exitCode = 1;
}
