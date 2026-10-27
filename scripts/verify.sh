#!/usr/bin/env bash
set -euo pipefail

# Full verifier for the autonomous agent loop: Node workspaces then Python.
# Assumes dependencies are already installed (see scripts/codex-setup.sh).
# No external server is needed. Most tests run in process; the Python HTTP
# contracts self-start a disposable built API on loopback (skipped offline).
# Playwright uses a separate disposable server in the parallel browser CI job.

npm run verify
python -m pytest
