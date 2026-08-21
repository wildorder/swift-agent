import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// One config for both source trees of this single workspace package. Backend
// tests run under node; frontend tests opt into happy-dom via the
// `@vitest-environment happy-dom` docblock (mirroring packages/react's setup).
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['backend/src/**/*.test.ts', 'frontend/src/**/*.test.{ts,tsx}'],
  },
});
