#!/bin/bash
# Launch Alef under the blue-green supervisor for development.
#
# On rebuild request (alef.rebuild tool or globalThis.alefRequestRebuild()):
#   1. Runs ALEF_SUPERVISOR_BUILD_COMMAND (npm run check by default)
#   2. Spawns a new green with the same session ID for continuity
#   3. Waits for the new green to be healthy ("router listening on")
#   4. Sends handoff_prepare to the old green, waits up to 5s for ack
#   5. Kills old green — new green is now active
#   Rolls back to old green if new green crashes before ready.
#
# Usage:
#   ./alef-dev.sh [alef args...]
#
# Examples:
#   ./alef-dev.sh
#   ./alef-dev.sh --debug
#   ./alef-dev.sh --model claude-sonnet-4-5

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ALEF_SUPERVISOR_GREEN_SCRIPT="${SCRIPT_DIR}/packages/runner/src/main.ts" \
ALEF_SUPERVISOR_BUILD_COMMAND="npm --prefix ${SCRIPT_DIR} run check" \
exec npx --prefix "${SCRIPT_DIR}" tsx "${SCRIPT_DIR}/packages/runner/src/supervisor.ts" "$@"
