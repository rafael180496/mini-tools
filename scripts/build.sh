#!/usr/bin/env bash
# Build de producción (limpia build/bin, compila frontend + backend, empaqueta).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$PATH:$(go env GOPATH)/bin"
command -v wails >/dev/null || { echo "Wails CLI no encontrado. Corre scripts/install.sh primero."; exit 1; }
# wails corre `pnpm install` y `pnpm build` por su cuenta (ver wails.json), así
# que pnpm tiene que estar antes de llamarlo — si no, el error sale de adentro
# de wails y no dice qué falta.
source "$ROOT_DIR/scripts/ensure-pnpm.sh"

VERSION="$(cat "$ROOT_DIR/VERSION" 2>/dev/null || echo dev)"
wails build -clean -ldflags "-X main.appVersion=$VERSION" "$@"

echo "==> Build listo:"
ls -lh build/bin/ 2>/dev/null || true
