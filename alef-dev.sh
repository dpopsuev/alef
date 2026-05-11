#!/bin/bash
# Launch Alef under the supervisor for development.
# The supervisor watches for exit code 75 from /rebuild,
# runs npm run build, and respawns Alef with the same session.
#
# Usage:
#   ./alef-dev.sh [alef args...]
#
# Examples:
#   ./alef-dev.sh
#   ./alef-dev.sh --session /path/to/session.jsonl
#   ./alef-dev.sh --provider anthropic --model claude-opus-4-6

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec npx tsx "${SCRIPT_DIR}/packages/coding-agent/src/supervisor.ts" "$@"
