#!/bin/bash
# Launch Alef from a git checkout (dev). In-process hot-reload is enabled
# automatically when NODE_ENV/development + a build script are present.
#
# Usage:
#   ./alef-dev.sh [alef args...]
#
# Examples:
#   ./alef-dev.sh
#   ./alef-dev.sh --debug
#   ./alef-dev.sh --model claude-sonnet-4-5

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec npx --prefix "${SCRIPT_DIR}" tsx \
  --tsconfig "${SCRIPT_DIR}/tsconfig.json" \
  "${SCRIPT_DIR}/packages/cli/src/entrypoint.ts" "$@"
