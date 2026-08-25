#!/usr/bin/env bash
# Deja `pnpm` disponible antes de invocar a wails o a vite. SE SOURCEA, no se
# ejecuta: el `export` tiene que quedar en el shell que después llama a wails.
#
# # Por qué existe
#
# Los paquetes globales de npm son **por versión de Node**. Con nvm, instalar
# una versión nueva deja atrás el pnpm que estaba en la anterior, y a partir de
# ahí el build muere con:
#
#     ERROR   exec: "pnpm": executable file not found in $PATH
#
# que lo tira el CLI de wails —porque es él quien corre `pnpm install` y
# `pnpm build`, ver wails.json— y no dice ni que el problema es el cambio de
# versión de Node, ni cómo se arregla. Pasó de verdad (Node 24.18 → 24.19), y
# perder media hora en eso una vez alcanza.
#
# # Por qué corepack y no `npm install -g pnpm`
#
# Porque `npm install -g` reintroduce exactamente el mismo problema en el
# siguiente cambio de versión de Node. corepack viene incluido con Node y la
# versión concreta de pnpm la fija el campo `packageManager` de
# frontend/package.json, así que todas las máquinas usan la misma y el lockfile
# no se reescribe solo.

# Nunca frenar un build para preguntar si se puede descargar pnpm: en un script
# no interactivo eso queda colgado esperando una tecla que nadie va a apretar.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  echo "==> pnpm no está en el PATH; habilitándolo con corepack"
  corepack enable pnpm >/dev/null 2>&1 || true
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm no está disponible, y este proyecto usa pnpm siempre (nunca npm ni yarn)."
  echo "Con Node ya instalado, habilitalo con:"
  echo "    corepack enable pnpm"
  echo "Si tampoco tenés corepack, actualizá Node: viene incluido desde la 16."
  exit 1
fi
