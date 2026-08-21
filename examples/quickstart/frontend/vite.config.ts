import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy `/api/*` to the backend session route so the browser calls a same-origin
// path and the backend keeps the workspace API key server-side.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4000',
    },
  },
});
