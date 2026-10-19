import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// The kit checker wants a site's own product script to say so with data-ejm-app, and Vite drops unknown attributes.
const markProductScript = {
  name: 'mark-product-script',
  transformIndexHtml: {
    order: 'post' as const,
    handler: (html: string) =>
      html.replace(/<script type="module"/, '<script data-ejm-app type="module"'),
  },
};

export default defineConfig({
  plugins: [markProductScript],
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 1422,
    strictPort: true,
    proxy: {
      '/api/': 'http://127.0.0.1:1423',
      '/downloads/': 'http://127.0.0.1:1423',
    },
  },
  build: { target: 'es2022' },
});
