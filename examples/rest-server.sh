#!/usr/bin/env bash
set -euo pipefail
: "${ABCM_API_TOKEN:?set ABCM_API_TOKEN to at least 16 characters}"
export ABCM_WORKSPACE_ID="${ABCM_WORKSPACE_ID:-example}"
export ABCM_WORKSPACE_ROOT="${ABCM_WORKSPACE_ROOT:-$PWD}"
exec bun run ./dist/cli/rest-server.js
