import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'review/dependency-sources/**'],
    ...(process.env.EJM_TEST_REPORT
      ? {
          reporters: ['default', 'json'],
          outputFile: { json: process.env.EJM_TEST_REPORT },
        }
      : {}),
  },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./app', import.meta.url)) } },
  clearScreen: false,
  server: { watch: { ignored: ['**/src-tauri/**', '**/.workbench/**', '**/target/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
