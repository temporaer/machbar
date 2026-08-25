# home-assistant/Dockerfile
#
# Build from the repo root so the full source tree is available as context:
#   docker build -f home-assistant/Dockerfile -t machbar-ha .
#
# When the HA builder is used (add-on repository / CI), BUILD_FROM is injected
# per architecture from home-assistant/build.yaml.

# Declare globally so it is available in the final FROM instruction below.
# Defaults to node:22-alpine for local/CI builds; the HA supervisor overrides
# this with an arch-specific HA base image (which includes bashio).
ARG BUILD_FROM=node:22-alpine

# ── Build stage (always uses node:22-alpine for the toolchain) ────────────────
FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json         apps/api/
COPY apps/web/package.json         apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/     apps/
RUN npm run build

# ── Runtime stage — uses the HA base image for bashio support ─────────────────
# BUILD_FROM is the global ARG declared at the top of this file.
FROM ${BUILD_FROM}

# Install Node.js runtime + helpers.
# HA base images are Alpine-based; this is a no-op if BUILD_FROM already has Node.
RUN apk add --no-cache nodejs npm dumb-init wget python3 make g++ \
    && mkdir -p /data /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DATABASE_FILE=machbar.db \
    BASE_PATH=/ \
    SEED_DATABASE=false

WORKDIR /app

# Install production npm dependencies
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json         apps/api/
COPY apps/web/package.json         apps/web/
RUN npm ci --omit=dev \
    && apk del python3 make g++

# Copy built artefacts from the builder stage
COPY --from=builder /build/packages/shared/dist packages/shared/dist/
COPY --from=builder /build/apps/api/dist         apps/api/dist/
COPY --from=builder /build/apps/api/drizzle      apps/api/drizzle/
COPY --from=builder /build/apps/web/dist         apps/web/dist/

# HA expects the startup script at /run.sh
COPY home-assistant/run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
