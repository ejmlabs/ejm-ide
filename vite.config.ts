import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

export const MONACO_SANITIZER = '/monaco-editor/esm/vs/base/browser/domSanitize.js';
export const MONACO_VENDORED_DOMPURIFY = './dompurify/dompurify.js';

// monaco-editor ships its own copy of DOMPurify, which npm overrides cannot reach. Resolve
// Monaco's one import of that copy to the dompurify package, so the version package.json
// pins is the one the app bundles. vite.config.test.ts fails if Monaco moves the import.
export function monacoUsesPackagedDompurify(): Plugin {
  return {
    name: 'monaco-uses-packaged-dompurify',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const from = importer?.split('?')[0]?.replaceAll('\\', '/');
      if (source !== MONACO_VENDORED_DOMPURIFY || !from?.endsWith(MONACO_SANITIZER)) {
        return null;
      }
      const resolved = await this.resolve('dompurify', importer, { ...options, skipSelf: true });
      if (!resolved) {
        throw new Error('Install the dompurify package; Monaco resolves its sanitizer to it.');
      }
      return resolved;
    },
  };
}

export default defineConfig({
  plugins: [monacoUsesPackagedDompurify(), react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./app', import.meta.url)) } },
  optimizeDeps: { rolldownOptions: { plugins: [monacoUsesPackagedDompurify()] } },
  clearScreen: false,
  server: { watch: { ignored: ['**/src-tauri/**', '**/.workbench/**', '**/target/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  // The website is its own package with its own install and tests (website/package.json).
  test: { exclude: [...configDefaults.exclude, 'website/**'] },
});
