#!/usr/bin/env bash
# Corre el binario ya compilado en build/bin (requiere haber corrido build.sh antes).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_BUNDLE="build/bin/mini-tools.app"
BIN_PATH="build/bin/mini-tools"

if [[ "$(uname)" == "Darwin" && -d "$APP_BUNDLE" ]]; then
  open "$APP_BUNDLE"
elif [[ -x "$BIN_PATH" ]]; then
  exec "$BIN_PATH"
else
  echo "No se encontró un build compilado en build/bin/. Corre scripts/build.sh primero."
  exit 1
fi
