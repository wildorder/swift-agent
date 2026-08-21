# ── WS-49: Playground app image (mediator + static frontend) ────────
#
# `@swiftagent/playground` depends on PRIVATE workspace packages
# (@swiftagent/db etc.) and is never published, so the deployable is built
# from the monorepo. One container serves both the mediator API/WebSocket
# and the built frontend (single deployable, pinned to one instance —
# see deploy/playground/README.md).
#
# Mirrors apps/server/Dockerfile's builder/runner split (layer-cached
# manifests → turbo build → --prod-pruned runtime).

# ── Stage 1: Builder ────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy lockfile, workspace config, and .npmrc first for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./

# Copy all package.json files to resolve workspace dependencies
COPY apps/playground/package.json apps/playground/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/react/package.json packages/react/package.json

# Install all deps (layer is cached when lockfile + package.jsons don't change)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build via Turborepo (respects ^build dependency ordering from turbo.json):
# compiles the backend (mediator) AND bundles the Vite frontend into
# apps/playground/dist/{backend,frontend}.
RUN pnpm turbo run build --filter=@swiftagent/playground...

# ── Stage 2: Runner ─────────────────────────────────────────────────
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json /app/.npmrc ./

COPY --from=builder /app/apps/playground/package.json apps/playground/package.json
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/db/package.json packages/db/package.json
COPY --from=builder /app/packages/sdk/package.json packages/sdk/package.json
COPY --from=builder /app/packages/react/package.json packages/react/package.json

# Built output: the mediator backend, the static frontend, and every
# workspace dependency's dist (declared deps only — an undeclared workspace
# import would crash this --prod-pruned image with ERR_MODULE_NOT_FOUND).
COPY --from=builder /app/apps/playground/dist apps/playground/dist
COPY --from=builder /app/apps/playground/backend/src/agent.ts apps/playground/backend/src/agent.ts
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/db/drizzle packages/db/drizzle
COPY --from=builder /app/packages/sdk/dist packages/sdk/dist
COPY --from=builder /app/packages/react/dist packages/react/dist

# Install production dependencies only (fresh install preserves symlinks)
RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
# The compiled server resolves dist/frontend relative to itself; make the
# static root explicit anyway so operators can see and override it.
ENV PLAYGROUND_STATIC_DIR=/app/apps/playground/dist/frontend

# Run as non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 swiftagent
USER swiftagent

# 4100: mediator HTTP + WebSocket (+ static frontend).
# 8090: the SDK tool runner hosting the playground's demo tools.
EXPOSE 4100 8090

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4100/health || exit 1

ENTRYPOINT []
CMD ["node", "apps/playground/dist/backend/server.js"]
