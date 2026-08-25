#!/bin/sh
# docker-entrypoint.sh
# Starts the API server, which applies Drizzle migrations and optionally seeds.
# This script is executed by dumb-init (PID 1), so "exec" below hands control
# directly to the node process for clean signal propagation.
set -e

# Ensure the persistent data directory exists.
# Matters when DATA_DIR is a bind-mount that may not have been created yet.
mkdir -p "${DATA_DIR}"

echo "[machbar] Starting API on ${HOST}:${PORT} (BASE_PATH=${BASE_PATH})"

cd /app/apps/api
exec node dist/index.js
