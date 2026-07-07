#!/usr/bin/env bash
# Instala el toolchain (Wails CLI) y las dependencias de Go + frontend.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Verificando toolchain base"
command -v go >/dev/null || { echo "Go no está instalado: https://go.dev/dl/"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm no está instalado (nunca npm/yarn). Instalar con: npm install -g pnpm"; exit 1; }

GOBIN="$(go env GOPATH)/bin"
export PATH="$PATH:$GOBIN"

if ! command -v wails >/dev/null; then
  echo "==> Instalando Wails CLI (github.com/wailsapp/wails/v2/cmd/wails)"
  go install github.com/wailsapp/wails/v2/cmd/wails@latest
else
  echo "==> Wails CLI ya instalado ($(wails version 2>/dev/null | head -1))"
fi

if [[ ":$PATH:" != *":$GOBIN:"* ]]; then
  echo "Nota: $GOBIN no está en tu PATH permanente."
  echo "Agrégalo a tu shell profile (ej. ~/.zshrc) para poder correr 'wails' directamente:"
  echo "  export PATH=\"\$PATH:$GOBIN\""
fi

echo "==> Descargando dependencias de Go"
go mod download

echo "==> Instalando dependencias del frontend (pnpm)"
(cd frontend && pnpm install)

echo "==> Listo. Usa scripts/start-dev.sh para desarrollo o scripts/build.sh para compilar."
