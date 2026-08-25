#!/usr/bin/env bash
# Levanta la app en modo desarrollo (backend Go + Vite con hot reload).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$PATH:$(go env GOPATH)/bin"
command -v wails >/dev/null || { echo "Wails CLI no encontrado. Corre scripts/install.sh primero."; exit 1; }
# `wails dev` levanta el watcher con `pnpm dev` (ver wails.json).
source "$ROOT_DIR/scripts/ensure-pnpm.sh"

wails dev "$@"
