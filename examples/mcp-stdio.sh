#!/usr/bin/env bash
set -euo pipefail
export ABCM_WORKSPACE_ID="${ABCM_WORKSPACE_ID:-example}"
export ABCM_WORKSPACE_ROOT="${ABCM_WORKSPACE_ROOT:-$PWD}"
exec bun run ./dist/cli/mcp-stdio.js
