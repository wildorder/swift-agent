import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    // WS-51 (SC-17): index.test.ts dynamically imports ../index.js, which
    // evaluates the full server module graph (~2.5s in isolation, unbounded
    // under `turbo run test` parallel load). The vitest 5000ms default made
    // the gate flaky-red. Suite-level so future heavy tests inherit the
    // budget — do not remove or undercut with per-test timeouts.
    testTimeout: 30_000,
  },
});
