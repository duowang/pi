#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="cli"
if [[ "${1:-}" == "replay" || "${1:-}" == "preflight" || "${1:-}" == "login" ]]; then
  MODE="$1"
  shift
fi
cd "$ROOT"
RESOLVER_URL="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$ROOT/packages/coding-agent/src/experimental/source-resolver.ts")"
exec node --import "$RESOLVER_URL" "$ROOT/packages/agent/examples/speculative/$MODE.ts" "$@"
