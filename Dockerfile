# ────────────────────────────────────────────────────────────────────────────
# Stage 1 — install ALL dependencies (including devDependencies for the build)
# ────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /build

# Copy workspace manifests first to maximise layer cache reuse
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json         apps/api/
COPY apps/web/package.json         apps/web/

RUN npm ci

# ────────────────────────────────────────────────────────────────────────────
# Stage 2 — build all workspaces
# ────────────────────────────────────────────────────────────────────────────
FROM deps AS builder

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/     apps/

RUN npm run build

# ────────────────────────────────────────────────────────────────────────────
# Stage 3 — minimal production image
# ────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# Defaults; all are overridable at runtime via -e / env_file / compose
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DATABASE_FILE=machbar.db \
    BASE_PATH=/ \
    SEED_DATABASE=false

WORKDIR /app

# dumb-init: proper PID-1 that forwards signals to child processes
# wget: used by the HEALTHCHECK below
RUN apk add --no-cache dumb-init wget python3 make g++ \
    && mkdir -p /data \
    && chown node:node /data

# Re-copy workspace manifests and install production deps only
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json         apps/api/
COPY apps/web/package.json         apps/web/

RUN npm ci --omit=dev \
    && apk del python3 make g++

# Copy compiled artefacts from the builder stage
COPY --from=builder /build/packages/shared/dist packages/shared/dist/
COPY --from=builder /build/apps/api/dist         apps/api/dist/
COPY --from=builder /build/apps/api/drizzle      apps/api/drizzle/
COPY --from=builder /build/apps/web/dist         apps/web/dist/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME /data
EXPOSE 3000

# The API exposes GET /api/health returning 2xx.
# --start-period gives the app time to run migrations before checks begin.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null http://localhost:3000/api/health || exit 1

USER node

# dumb-init sits as PID 1 and reaps orphan processes + forwards signals correctly
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
