#!/usr/bin/env bash
# Limpia artefactos y vuelve a compilar en un solo paso (clean.sh + build.sh), para iterar más rápido.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Limpiando"
"$ROOT_DIR/scripts/clean.sh"

echo "==> Compilando"
"$ROOT_DIR/scripts/build.sh" "$@"

echo "==> Rebuild listo."
