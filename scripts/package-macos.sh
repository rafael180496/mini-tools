#!/usr/bin/env bash
# Empaqueta build/bin/mini-tools.app en un .dmg distribuible para macOS.
#
# Build SIN FIRMAR (sin Apple Developer ID / notarización) — Gatekeeper va a
# mostrar "desarrollador no identificado" al abrirlo en otra máquina; el
# workaround (clic derecho → Abrir, o `xattr -cr`) se imprime al final. El
# "Self-signing application: Done." que hace `wails build` internamente es un
# self-sign ad-hoc de Wails, no una firma real de Developer ID — no hay nada
# que cambiar ahí.
#
# Sin comandos git/gh en ningún lado de este archivo — artefacto local
# únicamente, publicar el .dmg es manual.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "package-macos.sh solo corre en macOS (usa hdiutil)." >&2
  exit 1
fi

VERSION="$(cat VERSION 2>/dev/null || true)"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "VERSION inválido o faltante (\"$VERSION\") — esperado semver tipo 0.1.0." >&2
  exit 1
fi

echo "==> Empaquetando mini-tools v$VERSION para macOS"

# STAGE_DIR se crea más abajo; declarado acá para que el trap único de abajo
# pueda referenciarlo sin importar en qué paso falle el script.
STAGE_DIR=""
cleanup() {
  [[ -n "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"
  # Restaura wails.json siempre (éxito, error, o Ctrl-C) — el repo queda
  # byte-idéntico al terminar, nada que el usuario tenga que revertir en git.
  [[ -f wails.json.bak ]] && mv wails.json.bak wails.json
}
trap cleanup EXIT

cp wails.json wails.json.bak
sed -i '' "s/\"productVersion\": \"[^\"]*\"/\"productVersion\": \"$VERSION\"/" wails.json

echo "==> Compilando (scripts/build.sh)"
"$ROOT_DIR/scripts/build.sh"

APP_PATH="build/bin/mini-tools.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "No se encontró $APP_PATH después del build." >&2
  exit 1
fi

echo "==> Armando .dmg"
STAGE_DIR="$(mktemp -d)"

cp -R "$APP_PATH" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"

DMG_PATH="build/bin/mini-tools-v$VERSION.dmg"
hdiutil create -volname "mini-tools $VERSION" \
  -srcfolder "$STAGE_DIR" -ov -format UDZO \
  "$DMG_PATH"

echo "==> Listo: $DMG_PATH"
echo
echo "Build sin firmar — Gatekeeper va a avisar \"desarrollador no identificado\" al abrirlo en otra máquina."
echo "Workaround: clic derecho sobre la app → Abrir (o \`xattr -cr /Applications/mini-tools.app\`,"
echo "o Ajustes del Sistema → Privacidad y Seguridad → Abrir de todas formas)."
