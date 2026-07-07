#!/usr/bin/env bash
# Build de producción (limpia build/bin, compila frontend + backend, empaqueta).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$PATH:$(go env GOPATH)/bin"
command -v wails >/dev/null || { echo "Wails CLI no encontrado. Corre scripts/install.sh primero."; exit 1; }

wails build -clean "$@"

echo "==> Build listo:"
ls -lh build/bin/ 2>/dev/null || true
