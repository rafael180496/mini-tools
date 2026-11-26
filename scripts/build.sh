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

# En macOS, un build sin firmar (o ad-hoc) cambia de CDHash en cada compilación
# y hace que TCC vuelva a pedir permiso de Documentos/Escritorio/Descargas.
# Si existe un certificado local de firma de código (export MACOS_SIGN_IDENTITY="mini-tools-dev"),
# firmamos el .app con esa identidad estable para que macOS recuerde el permiso entre rebuilds.
if [[ "$(uname -s)" == "Darwin" && -n "${MACOS_SIGN_IDENTITY:-}" && -d "build/bin/mini-tools.app" ]]; then
  echo "==> Firmando build/bin/mini-tools.app con '$MACOS_SIGN_IDENTITY' (evita re-prompts TCC)"
  codesign --force --deep --sign "$MACOS_SIGN_IDENTITY" "build/bin/mini-tools.app"
fi

echo "==> Build listo:"
ls -lh build/bin/ 2>/dev/null || true
