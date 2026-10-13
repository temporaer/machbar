#!/usr/bin/env bash
set -euo pipefail

# Full verifier for the autonomous agent loop: Node workspaces then Python.
# Assumes dependencies are already installed (see scripts/codex-setup.sh).
# None of these checks need a running server: vitest is in-process, the API
# uses an embedded better-sqlite3 file, and the Python tests run through the
# in-process pytest-homeassistant-custom-component harness. Playwright e2e is
# intentionally excluded from this loop.

npm run verify
python -m pytest
