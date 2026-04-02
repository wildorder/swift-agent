# WS-12: CI Pipeline, Docker & Branch Strategy

## Goal

Implement the continuous integration pipeline, Docker container builds, local development stack, branch protection model, and SDK publishing workflow. This workstream establishes the quality gates that every code change passes through and the container packaging used by the deployment workstream (WS-13). It is intentionally decoupled from cloud infrastructure so CI can start running from the first PR.

## Dependencies

- WS-01

## Package

Root-level CI/CD configuration: `.github/workflows/`, `apps/server/Dockerfile`, `docker-compose.yml`

## Files Touched

- `.github/workflows/ci.yml`
- `.github/workflows/publish-sdks.yml`
- `apps/server/Dockerfile`
- `apps/server/.dockerignore`
- `docker-compose.yml`
- `.github/CODEOWNERS`
- `.github/pull_request_template.md`

## Implementation Steps

### Part A: CI Pipeline (every PR)

1. **CI workflow (`.github/workflows/ci.yml`)**: Triggers on every pull request to any branch and on push to `dev`, `staging`, and `main`. Jobs:

   **Job 1 — Build & Lint:**
   - Checkout code
   - Setup Node.js (LTS) with pnpm caching (`pnpm store` cache key based on `pnpm-lock.yaml` hash)
   - `pnpm install --frozen-lockfile`
   - `pnpm typecheck` — TypeScript strict compilation across all packages (Turborepo parallelized)
   - `pnpm lint` — ESLint across all packages
   - `pnpm build` — Full production build of all packages
   - Upload build artifacts for downstream jobs

   **Job 2 — Unit Tests** (parallel with Job 1 after install):
   - `pnpm test` — Unit tests via Vitest (no external services, fast)

   **Job 3 — Integration Tests** (runs after Job 1 + Job 2 pass):
   - Start Postgres and Redis as GitHub Actions service containers (faster than testcontainers in CI)
   - Set `DATABASE_URL` and `REDIS_URL` from service container connection strings
   - Run database migrations against CI Postgres
   - `pnpm test:integration` — Repository tests, API route tests
   - `pnpm test:integration` covers repository, API route, and gateway integration tests

2. **Turborepo remote caching** (optional): Configure Turborepo remote cache (Vercel or self-hosted) to share build caches across CI runs. Reduces build times for unchanged packages. Enable via `TURBO_TOKEN` and `TURBO_TEAM` env vars in CI.

### Part B: Container Build

3. **Dockerfile (`apps/server/Dockerfile`)**: Multi-stage build:
   - **Stage 1 (deps)**: `node:22-alpine`, enable corepack, install pnpm, copy `pnpm-lock.yaml` + `pnpm-workspace.yaml` + all `package.json` files, `pnpm install --frozen-lockfile` — cached layer for dependencies
   - **Stage 2 (builder)**: Copy source, `pnpm --filter @swiftagent/server... build` (builds server and all workspace dependencies via Turborepo)
   - **Stage 3 (runner)**: `node:22-alpine`, copy built `dist/` and pruned production `node_modules` via `pnpm deploy --filter @swiftagent/server --prod`, set `NODE_ENV=production`, `USER node`, expose port, health check `CMD`, entrypoint `["node", "dist/main.js"]`
   - Pin Node.js major version in Dockerfile to match `.nvmrc` or `engines` field
   - Use `.dockerignore` to exclude `node_modules`, `.git`, `docs`, `tasks`, `tests`, `.turbo`, `.github`

4. **Docker Compose (`docker-compose.yml`)**: Local development stack:
   - `postgres:16-alpine` with volume mount, health check (`pg_isready`), port 5432, default dev credentials
   - `redis:7-alpine` with port 6379
   - `swift-agent` service building from `apps/server/Dockerfile`, depends on postgres and redis (condition: `service_healthy`), env vars from `.env` file with dev defaults documented in comments
   - A developer can `docker compose up` to run the full stack locally without installing Postgres or Redis natively

### Part C: Branch Strategy & Repo Config

5. **Branch model**: Three long-lived branches:
   - `dev` — integration branch. Feature branches merge here via PR. Push to `dev` triggers dev deployment (WS-13).
   - `staging` — pre-production. PRs from `dev` merge here. Push triggers staging deployment (WS-13).
   - `main` — production. PRs from `staging` merge here. Push (or GitHub Release) triggers prod deployment (WS-13).

6. **Branch protection rules** (document for manual GitHub setup):
   - `dev`: Require CI passing. Allow direct push for hotfixes or require PR — team choice.
   - `staging`: Require CI passing. Require 1 approval. No direct push.
   - `main`: Require CI passing. Require 1 approval. No direct push.

7. **CODEOWNERS (`.github/CODEOWNERS`)**: Assign reviewers for critical paths:
   - `packages/db/` → database owner
   - `packages/runtime/` → runtime owner
   - `.github/workflows/` → infra owner
   - `infra/` → infra owner
   - `*` → default team

8. **PR template (`.github/pull_request_template.md`)**: Checklist:
   - Description of change
   - Linked workstream / issue
   - Tests added or updated
   - Database migration required (yes/no)
   - Environment variables added or changed (yes/no)
   - Breaking changes (yes/no)

### Part D: SDK Publishing

9. **Publish SDKs (`.github/workflows/publish-sdks.yml`)**: Triggers on GitHub Release publish event. Steps:
   - Checkout code at release tag
   - `pnpm install --frozen-lockfile`
   - Build `@swiftagent/sdk` and `@swiftagent/react` packages
   - Set version from release tag (e.g., `v1.0.0` → `1.0.0`) via pnpm version or manual `package.json` update
   - Publish `@swiftagent/sdk` to npm via `pnpm publish --filter @swiftagent/sdk --no-git-checks`
   - Publish `@swiftagent/react` to npm via `pnpm publish --filter @swiftagent/react --no-git-checks`
   - Uses `NPM_TOKEN` from GitHub secrets with `npm` provenance enabled
   - Only publishes if the package version differs from the currently published version (`npm view` check)

## Tests

1. CI workflow runs successfully on a test PR: typecheck, lint, unit tests, build all pass.
2. Integration test job starts Postgres/Redis service containers and runs integration tests.
3. Docker image builds successfully from `apps/server/Dockerfile` and the container starts with health check passing.
4. `docker compose up` starts the full local stack (Postgres, Redis, server) and health check responds `200`.
5. SDK publish workflow (dry run) correctly identifies packages and versions.
6. Branch protection prevents direct push to `staging` and `main`.

## Acceptance Criteria

1. Every PR triggers CI: typecheck, lint, unit tests, integration tests, and build — all must pass before merge.
2. CI runs in under 10 minutes for a typical PR (with Turborepo caching).
3. Docker image builds are reproducible: same commit SHA produces the same image layers (pinned base image, frozen lockfile).
4. `docker compose up` provides a complete local development environment with zero external dependencies.
5. SDK packages are publishable to npm via the GitHub Release workflow with provenance.
6. Branch protection rules enforce the promotion chain: feature → dev → staging → main.
7. CODEOWNERS and PR template are configured and active.
