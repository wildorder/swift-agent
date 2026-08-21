import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    // Testcontainers suites (Docker) run via the root `pnpm test:integration`
    // config, never in the unit `pnpm test` gate — same split as test/integration.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
