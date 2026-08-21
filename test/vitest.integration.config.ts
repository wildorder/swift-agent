import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'test/integration/**/*.integration.test.ts',
      // WS-49: package-local Testcontainers suites (own throwaway container).
      'packages/db/src/__tests__/**/*.integration.test.ts',
    ],
    globalSetup: ['./test/setup-db.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
