// biome-ignore assist/source/organizeImports: TypeScript 6.0.3 crashes ("parameter should have errors") when the @ejm imports come before the vite ones
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { ejmSite } from '@ejm/site/vite';
import { ejmSsg } from '@ejm/ssg/vite';

// ejmSite writes the shared head tags, theme-boot.js, the ide brand files and _headers. ejmSsg prerenders every route.
// Only website/static is served. Retained historical captures in website/public are not public build assets.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: 'static',
  // The linked ejm-ui packages would otherwise bring their own React (ADOPTION.md, route A).
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  plugins: [tailwindcss(), react(), ejmSite({ project: 'ide' }), ejmSsg({ site: 'src/site.tsx' })],
  server: {
    host: '127.0.0.1',
    port: 1422,
    strictPort: true,
    // `npm run site:preview` serves the Worker (releases API and installer downloads) on 1423.
    proxy: {
      '/api/': 'http://127.0.0.1:1423',
      '/downloads/': 'http://127.0.0.1:1423',
    },
  },
  build: { target: 'es2022', cssMinify: 'lightningcss', outDir: 'dist', emptyOutDir: true },
});
