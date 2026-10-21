import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./app', import.meta.url)) },
    dedupe: ['react', 'react-dom', 'lucide-react'],
  },
  clearScreen: false,
  server: { watch: { ignored: ['**/src-tauri/**', '**/.workbench/**', '**/target/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
