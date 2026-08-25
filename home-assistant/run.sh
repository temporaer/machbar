#!/bin/sh
# home-assistant/run.sh
# Startup script for the Machbar Home Assistant add-on.
# Runs inside the HA supervisor environment where bashio is available.
set -e

# ── Read add-on options via bashio (present when using HA base images) ────────
if command -v bashio >/dev/null 2>&1; then
  SEED_DATABASE=$(bashio::config 'seed_database')
  export SEED_DATABASE
fi

export DATA_DIR="${DATA_DIR:-/data}"
export PORT="${PORT:-3000}"
export HOST="${HOST:-0.0.0.0}"
export DATABASE_FILE="${DATABASE_FILE:-machbar.db}"
export BASE_PATH="${BASE_PATH:-/}"

mkdir -p "${DATA_DIR}"

echo "[machbar] Starting on ${HOST}:${PORT} (BASE_PATH=${BASE_PATH:-/})"

cd /app/apps/api
exec node dist/index.js
