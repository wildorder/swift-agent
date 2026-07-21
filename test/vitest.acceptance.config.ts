import { defineConfig } from 'vitest/config';

/**
 * WS-42 · Quickstart acceptance suite config — a sibling of
 * `test/vitest.integration.config.ts`. It reuses the SAME Testcontainers
 * Postgres boot (`./test/setup-db.ts` as `globalSetup`, which starts
 * `postgres:16-alpine`, sets `DATABASE_URL`, and applies the committed Drizzle
 * migrations) so the acceptance stack runs against exactly the CI/deploy schema.
 *
 * Timeouts are far more generous than the integration config's 30s/60s because
 * the install-from-registry scenario shells out to a bounded `npm install`
 * against GitHub Packages and boots a consumer typecheck + drive.
 *
 * Redis is intentionally OFF: `createRuntimeHarness()` builds the gateway with
 * `redisEnabled: false` (single-node), so no fanout bus is needed and the run is
 * fully deterministic. See the WS-42 Design Notes.
 *
 * NOTE (project convention): the root `test/` tree is EXCLUDED from
 * `pnpm typecheck` / `pnpm lint`; this suite is validated by *running* it
 * (`pnpm test:acceptance`, needs Docker), not by the monorepo typecheck/lint
 * gates.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/acceptance/**/*.acceptance.test.ts'],
    globalSetup: ['./test/setup-db.ts'],
    // The install step + server boot are slow — absorb them without flaking.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Deterministic serial execution: the harness shares one fake-provider
    // instance whose responder is swapped per scenario, so scenarios must not
    // interleave.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
