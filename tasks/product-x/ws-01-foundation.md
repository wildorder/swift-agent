# WS-01: Project Foundation & Monorepo Setup

## Goal

Establish a greenfield TypeScript monorepo using pnpm workspaces and Turborepo so every Swift Agent package (`shared`, `db`, `models`, `runtime`, `gateway`, `api`, `sdk`, `react`, `observability`) exists as a buildable, testable stub with shared tooling: strict TypeScript, Vitest, ESLint, Prettier, path aliases (`@swiftagent/*`), and CI-ready scripts (`build`, `test`, `lint`, `typecheck`) that succeed on a clean clone.

## Dependencies

- None

## Package

Monorepo root; stub packages: `packages/shared`, `packages/db`, `packages/models`, `packages/runtime`, `packages/gateway`, `packages/api`, `packages/sdk`, `packages/react`, `packages/observability`; stub app: `apps/server`.

## Files Touched

- `package.json` (root) — includes `ioredis` (workspace dependency for Redis client stub); dev deps `testcontainers`, `@testcontainers/postgresql` for integration tests
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `turbo.json`
- `vitest.workspace.ts`
- `.gitignore`
- `.npmrc`
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`
- `packages/shared/src/index.ts`
- `packages/shared/src/redis.ts` (or `redis-client.ts`) — Redis client factory stub using `ioredis`
- `packages/db/package.json`
- `packages/db/tsconfig.json`
- `packages/db/src/index.ts`
- `packages/models/package.json`
- `packages/models/tsconfig.json`
- `packages/models/src/index.ts`
- `packages/runtime/package.json`
- `packages/runtime/tsconfig.json`
- `packages/runtime/src/index.ts`
- `packages/gateway/package.json`
- `packages/gateway/tsconfig.json`
- `packages/gateway/src/index.ts`
- `packages/api/package.json`
- `packages/api/tsconfig.json`
- `packages/api/src/index.ts`
- `packages/sdk/package.json`
- `packages/sdk/tsconfig.json`
- `packages/sdk/src/index.ts`
- `packages/react/package.json`
- `packages/react/tsconfig.json`
- `packages/react/src/index.ts`
- `packages/observability/package.json`
- `packages/observability/tsconfig.json`
- `packages/observability/src/index.ts`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `apps/server/src/index.ts`
- `eslint.config.js` (or `eslint.config.mjs`) at root
- `.prettierrc` / `.prettierignore` (or Prettier block in root config)
- Optional: `packages/*/vitest.config.ts` or single root Vitest pattern as needed
- Vitest global setup for integration tests (e.g. `vitest.setup.ts` or `test/setup-db.ts`) — starts/stops a Postgres Testcontainers instance

## Implementation Steps

1. **Root init**: Run `pnpm init` at repo root; set `"private": true`, `"packageManager"` field for Corepack/pnpm version pin, and scripts: `build`, `test`, `lint`, `typecheck`, `clean` delegating to Turborepo (`turbo run ...`).
2. **Workspace layout**: Add `pnpm-workspace.yaml` with `packages: ['packages/*', 'apps/*']`.
3. **TypeScript base**: Create `tsconfig.base.json` with `"strict": true`, `"moduleResolution": "bundler"` or `"node16"`/`"nodenext"` consistently, `"target"` appropriate for Node LTS, `"declaration": true`, `"composite": true` if using project references, `"skipLibCheck": true`, and `paths` mapping `@swiftagent/shared`, `@swiftagent/db`, `@swiftagent/models`, `@swiftagent/runtime`, `@swiftagent/gateway`, `@swiftagent/api`, `@swiftagent/sdk`, `@swiftagent/react`, `@swiftagent/observability` to each package `src` entry.
4. **Per-package tsconfig**: Each package extends `tsconfig.base.json` with `"rootDir": "src"`, `"outDir": "dist"`, and `references` to internal deps if using project references (e.g. `db` references `shared`).
5. **Package stubs**: For each of the nine `packages/*` and `apps/server`, add `package.json` with `name` matching scope (`@swiftagent/shared`, etc.), `"type": "module"`, `"main"`/`"types"` pointing to `dist`, `"exports"` map for clean subpath if needed, `scripts`: `build` (`tsc`), `test` (`vitest run`), `typecheck` (`tsc --noEmit`), minimal `dependencies`/`devDependencies` (typescript, vitest, eslint types as needed).
5b. **Redis client (workspace)**: Add `ioredis` as a workspace-level dependency (root `package.json` `devDependencies` or hoisted dep, plus `packages/shared` or a shared internal dep as appropriate). Add a minimal **Redis client factory stub** in `packages/shared` (e.g. `createRedisClient(url: string)` or `getRedis()`) so `gateway` and other packages can import a single factory without duplicating connection logic; implementation can be a no-op or throw until URLs exist in later workstreams.
5c. **Testcontainers (dev)**: Add `testcontainers` and `@testcontainers/postgresql` as **dev dependencies** at the root (or in `packages/db` if tests live there—prefer root so all packages can reuse). Wire Vitest **global setup** (e.g. `vitest.setup.ts` or `test/setup-db.ts`) that starts a Postgres container before the test run and stops it after, exposing `DATABASE_URL` (or equivalent) to integration tests via `process.env` or a test-only module.
6. **Stub entrypoints**: Each `src/index.ts` exports a minimal named constant or function (e.g. `export const SWIFT_AGENT_PACKAGE = 'shared'`) so cross-imports can be smoke-tested.
7. **Cross-package wiring**: Add `workspace:*` or `workspace:^` deps where one stub imports another (e.g. `@swiftagent/db` depends on `@swiftagent/shared`) to prove resolution; at minimum one package imports `@swiftagent/shared` in code and types resolve.
8. **Turborepo**: Add `turbo.json` with pipeline tasks `build`, `test`, `lint`, `typecheck` with `dependsOn: ["^build"]` for build where appropriate, outputs `dist/**`, caching enabled.
9. **Vitest**: Add `vitest.workspace.ts` (or Vitest 2+ workspace config) aggregating all packages; each package may have `vitest.config.ts` extending root defaults or inline in workspace file; ensure empty test glob still exits 0. Reference the global setup file in Vitest config (`globalSetup` or setupFiles as appropriate) so Testcontainers lifecycle runs for integration tests only (unit tests can skip or use a separate project).
10. **ESLint + Prettier**: Flat `eslint.config` with TypeScript parser, `@typescript-eslint`, recommended rules tightened for `strict`; Prettier integrated (eslint-config-prettier) to avoid conflicts; root scripts `lint` run ESLint across packages.
11. **Repo hygiene**: `.gitignore` node_modules, dist, coverage, .turbo, env files, IDE junk; `.npmrc` with `strict-peer-dependencies`, `auto-install-peers` as team prefers, and `shamefully-hoist` only if required (prefer false).
12. **Smoke test**: Add at least one trivial test file (e.g. `packages/shared/src/index.test.ts`) asserting the stub export; optional test in a consumer package importing `@swiftagent/shared`.
13. **Testcontainers smoke**: Add an integration test (can live under `packages/db` or root `test/`) that verifies Testcontainers can spin up Postgres, connect with a standard client (e.g. `postgres`/`pg`), and tear down cleanly—proving downstream workstreams (WS-03+) can rely on the same harness.
14. **Verification**: Document in README or root comment block that `pnpm install && pnpm build && pnpm typecheck && pnpm test` is the local gate (README only if already present; otherwise skip per project rules—user said no summary docs unless asked; task file is sufficient).

## Tests

1. `pnpm install` completes without peer resolution errors (or documented overrides).
2. `pnpm build` succeeds and emits `dist` for all packages/apps that compile.
3. `pnpm typecheck` succeeds with zero TypeScript errors across the workspace.
4. `pnpm test` runs Vitest; empty suites pass; smoke test passes if present.
5. A file in one package imports another via `@swiftagent/*` and `tsc` resolves it.
6. `pnpm lint` (if wired) completes with zero errors on stub code.
7. Integration test: Testcontainers starts Postgres; test connects successfully (validates global setup and dev dependencies).

## Acceptance Criteria

1. A developer can clone the repository, run `pnpm install && pnpm build`, and get a clean build with no errors for all defined packages and `apps/server`.
2. TypeScript `strict` mode is enabled via the shared base config for every package.
3. Turborepo runs `build`, `test`, `lint`, and `typecheck` tasks without manual per-package ordering beyond declared dependencies.
4. Path aliases `@swiftagent/*` resolve at compile time for cross-package imports.
5. Vitest is configured workspace-wide; tests execute successfully (including zero-test packages if configured to no-op safely).
6. ESLint and Prettier configs are shared from the root and applicable to all packages.
7. Integration test infrastructure (Testcontainers for Postgres) is configured and working so downstream workstreams (WS-03+) can run DB tests.
