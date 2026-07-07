#!/usr/bin/env bash
# Limpia artefactos de build. Con --all también borra node_modules y la cache de Go.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Limpiando build/bin"
rm -rf build/bin

echo "==> Limpiando frontend/dist"
rm -rf frontend/dist

echo "==> Limpiando binario suelto de 'go build ./...' (si existe)"
rm -f mini-tools

if [[ "${1:-}" == "--all" ]]; then
  echo "==> Limpiando frontend/node_modules (--all)"
  rm -rf frontend/node_modules
  echo "==> Limpiando cache de build de Go (--all)"
  go clean -cache
fi

echo "==> Listo."
