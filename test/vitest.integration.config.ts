import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['integration/**/*.integration.test.ts'],
    globalSetup: ['./setup-db.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
