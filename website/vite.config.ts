import { ejmlabs } from '@ejm/site/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [ejmlabs({ project: 'ide' })],
  server: {
    host: '127.0.0.1',
    port: 1422,
    strictPort: true,
    // The release list and installers come from the Worker (npm run site:preview on port 1423).
    proxy: {
      '/api/': 'http://127.0.0.1:1423',
      '/downloads/': 'http://127.0.0.1:1423',
    },
  },
});
