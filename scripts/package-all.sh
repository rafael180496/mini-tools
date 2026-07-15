#!/usr/bin/env bash
# Empaqueta TODOS los SO soportados en la misma pasada: macOS (nativo,
# requiere correr esto desde una Mac) + Windows (cross-compilado, corre
# desde cualquier SO con Go+Wails). Ver .claude/specs/releases.md — este es
# el script que corresponde al trigger "preparar la versión nueva"/
# "empaquetar"/"oficial": por default arma AMBOS artefactos, no uno solo.
#
# Cada plataforma corre su propio scripts/package-<os>.sh sin cambios — este
# archivo es solo el orquestador, no duplica lógica de empaquetado (mismo
# principio que package-macos.sh/package-windows.sh ya siguen: un script por
# SO, nunca uno genérico que intente cubrir varios).
#
# Por qué hace falta un STAGE_DIR: tanto package-macos.sh como
# package-windows.sh llaman a `wails build -clean`, que BORRA todo
# build/bin/ al arrancar — si se corren en secuencia sin más, el segundo
# script borra el artefacto que dejó el primero antes de poder copiarlo a
# ningún lado (bug real, encontrado corriendo este mismo script). Por eso
# cada artefacto se mueve a un directorio temporal apenas su script
# termina, y recién al final se devuelven todos juntos a build/bin/.
#
# Sin comandos git/gh en ningún lado — artefactos locales únicamente,
# publicarlos es manual.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(cat VERSION 2>/dev/null || true)"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "VERSION inválido o faltante (\"$VERSION\") — esperado semver tipo 0.1.0." >&2
  exit 1
fi

echo "==> Empaquetando mini-tools v$VERSION para todos los SO soportados"
echo

STAGE_DIR="$(mktemp -d)"
cleanup() { rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

BUILT=()

if [[ "$(uname)" == "Darwin" ]]; then
  echo "==> [1/2] macOS"
  "$ROOT_DIR/scripts/package-macos.sh"
  mv "build/bin/mini-tools-v$VERSION.dmg" "$STAGE_DIR/"
  BUILT+=("mini-tools-v$VERSION.dmg")
  echo
else
  echo "==> [1/2] macOS — SALTEADO (package-macos.sh usa hdiutil, solo corre en macOS; este host es $(uname))"
  echo
fi

echo "==> [2/2] Windows (cross-compilado)"
"$ROOT_DIR/scripts/package-windows.sh"
mv "build/bin/mini-tools-v$VERSION-windows-amd64.exe" "$STAGE_DIR/"
BUILT+=("mini-tools-v$VERSION-windows-amd64.exe")
echo

# Devolver todos los artefactos juntos a build/bin/ — a esta altura ya no
# va a correr ningún otro `wails build -clean` que los borre.
for f in "${BUILT[@]}"; do
  mv "$STAGE_DIR/$f" "build/bin/$f"
done

echo "==> Listo. Artefactos generados:"
for f in "${BUILT[@]}"; do
  echo "  - build/bin/$f"
done
echo
echo "Copiar cada uno a su releases/<os>/, calcular checksum, y actualizar"
echo "releases/<os>/README.md + README.md raíz + CHANGELOG.md — ver"
echo ".claude/specs/releases.md para el proceso completo paso a paso."
