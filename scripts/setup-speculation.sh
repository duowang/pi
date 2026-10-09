#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATASET="${1:-$ROOT/../pi-benchmark-tasks}"
DATASET_REV="7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f"
cd "$ROOT"
npm ci --ignore-scripts
npm run hydrate:model-data
if [[ ! -d "$DATASET" ]]; then
  git clone https://github.com/Aider-AI/polyglot-benchmark.git "$DATASET"
  git -C "$DATASET" checkout --detach "$DATASET_REV"
fi
if [[ "$(git -C "$DATASET" rev-parse HEAD)" != "$DATASET_REV" ]]; then
  echo "Dataset revision differs from $DATASET_REV. Use a separate checkout at that revision." >&2
  exit 1
fi
bash scripts/speculate.sh preflight "$DATASET"
