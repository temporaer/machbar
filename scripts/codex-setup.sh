#!/usr/bin/env bash
set -euo pipefail

# Reproducible setup for the Codex cloud environment.
#
# This runs in Codex cloud's network-enabled setup phase. The agent loop itself
# runs with networking DISABLED, so every dependency the offline loop needs must
# be installed here. The script is idempotent and safe to re-run.

npm ci
python -m pip install -r requirements-test.txt
