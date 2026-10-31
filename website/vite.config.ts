import { ejmlabs } from '@ejm/site/vite';
import { defineConfig } from 'vite';

// ejmlabs() is the shared setup: Tailwind, React, the design guard, the shared head and headers, prerendering and the build options.
// The dev server proxies the Worker's routes, so the live download list works with `npm run site:preview` running.
// The prerender bundles every dependency (`ssr.noExternal`). Otherwise Node resolves the leftover bare imports from
// `website/.ejm-ssg/` upward, and the desktop app's `node_modules` in the parent folder supplies a second React.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [ejmlabs({ project: 'ide' })],
  ssr: { noExternal: true },
  server: {
    host: '127.0.0.1',
    port: 1422,
    strictPort: true,
    proxy: {
      '/api/': 'http://127.0.0.1:1423',
      '/downloads/': 'http://127.0.0.1:1423',
    },
  },
});
