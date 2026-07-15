#!/usr/bin/env bash
# Cross-compila build/bin/mini-tools.exe para Windows (windows/amd64) y lo
# versiona como mini-tools-vX.Y.Z-windows-amd64.exe.
#
# Verificado corriendo DESDE macOS (arm64) — no depende de CGO (los 3
# conectores + go-redis son pure Go, `go build` cross-compila limpio a PE32+
# sin mingw/toolchain de Windows), y `wails build -platform windows/amd64`
# genera igual el manifest/ícono/loader de WebView2 necesarios sin correr en
# Windows. NO verificado corriendo el .exe resultante en una máquina Windows
# real — cross-compilar solo prueba que compila, no que corre (WebView2
# runtime, DPI scaling, diálogos nativos, todo eso solo se prueba en
# Windows real). No verificado tampoco cross-compilando desde Linux.
#
# Portable únicamente — NO arma instalador NSIS (requiere `makensis`, no
# instalado en este entorno; `wails doctor` lo lista como dependencia
# opcional). El .exe corre standalone, sin instalación, mismo criterio que
# cualquier build "portable" de Windows.
#
# Sin comandos git/gh en ningún lado de este archivo — artefacto local
# únicamente, publicarlo es manual (mismo criterio que package-macos.sh).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$PATH:$(go env GOPATH)/bin"
command -v wails >/dev/null || { echo "Wails CLI no encontrado. Corre scripts/install.sh primero."; exit 1; }

VERSION="$(cat VERSION 2>/dev/null || true)"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "VERSION inválido o faltante (\"$VERSION\") — esperado semver tipo 0.1.0." >&2
  exit 1
fi

echo "==> Empaquetando mini-tools v$VERSION para Windows (amd64)"

cp wails.json wails.json.bak
cleanup() {
  # Restaura wails.json siempre (éxito, error, o Ctrl-C) — el repo queda
  # byte-idéntico al terminar, nada que el usuario tenga que revertir en git.
  [[ -f wails.json.bak ]] && mv wails.json.bak wails.json
}
trap cleanup EXIT

sed -i '' "s/\"productVersion\": \"[^\"]*\"/\"productVersion\": \"$VERSION\"/" wails.json

echo "==> Compilando (wails build -platform windows/amd64)"
wails build -clean -platform windows/amd64 -ldflags "-X main.appVersion=$VERSION"

EXE_PATH="build/bin/mini-tools.exe"
if [[ ! -f "$EXE_PATH" ]]; then
  echo "No se encontró $EXE_PATH después del build." >&2
  exit 1
fi

VERSIONED_PATH="build/bin/mini-tools-v$VERSION-windows-amd64.exe"
cp "$EXE_PATH" "$VERSIONED_PATH"

echo "==> Listo: $VERSIONED_PATH"
echo
echo "Portable, sin instalador — copiar el .exe a la máquina Windows y correrlo directo."
echo "Sin firma Authenticode — Windows SmartScreen probablemente avise \"Windows protegió su PC\"."
echo "Workaround: \"Más información\" → \"Ejecutar de todas formas\"."
echo
echo "NO VERIFICADO en una Windows real — solo se confirmó que cross-compila limpio desde macOS."
