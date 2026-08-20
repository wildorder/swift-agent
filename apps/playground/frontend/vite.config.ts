import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Single-package layout: this config lives in `frontend/` and pins the Vite
// root there so `vite -c frontend/vite.config.ts` works from the package root.
// `/api/*` is proxied to the backend so the browser calls a same-origin path
// and the backend keeps the workspace API key server-side.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4100',
      // WS-49: the mediator mint route + the proxied WebSocket stream.
      '/playground': {
        target: 'http://127.0.0.1:4100',
        ws: true,
      },
    },
  },
});
