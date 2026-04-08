# ── Stage 1: Builder ────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy lockfile, workspace config, and .npmrc first for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./

# Copy all package.json files to resolve workspace dependencies
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/models/package.json packages/models/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/react/package.json packages/react/package.json

# Install all deps (layer is cached when lockfile + package.jsons don't change)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build via Turborepo (respects ^build dependency ordering from turbo.json)
RUN pnpm turbo run build --filter=@swiftagent/server...

# ── Stage 2: Runner ─────────────────────────────────────────────────
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config and root package.json
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json /app/.npmrc ./

# Copy all package.json files
COPY --from=builder /app/apps/server/package.json apps/server/package.json
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/db/package.json packages/db/package.json
COPY --from=builder /app/packages/models/package.json packages/models/package.json
COPY --from=builder /app/packages/runtime/package.json packages/runtime/package.json
COPY --from=builder /app/packages/gateway/package.json packages/gateway/package.json
COPY --from=builder /app/packages/api/package.json packages/api/package.json
COPY --from=builder /app/packages/observability/package.json packages/observability/package.json

# Copy built dist output from all packages
COPY --from=builder /app/apps/server/dist apps/server/dist
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/models/dist packages/models/dist
COPY --from=builder /app/packages/runtime/dist packages/runtime/dist
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist
COPY --from=builder /app/packages/api/dist packages/api/dist
COPY --from=builder /app/packages/observability/dist packages/observability/dist

# Install production dependencies only (fresh install preserves symlinks)
RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production

# Run as non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 swiftagent
USER swiftagent

# Expose API and Gateway ports
EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "apps/server/dist/main.js"]
