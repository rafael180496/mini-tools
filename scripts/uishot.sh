#!/usr/bin/env bash
# Captura una vista de la interfaz sin abrir la app.
#
# Por qué existe: la app es de escritorio y sacarle una foto desde afuera pide
# el permiso de grabación de pantalla de macOS, que un proceso automatizado no
# tiene — `screencapture` falla con "could not create image from display".
# Acá los componentes se montan en Chrome headless con los bindings de Wails
# simulados (frontend/src/uishot.tsx), y el navegador se fotografía a sí mismo.
#
#   ./scripts/uishot.sh files            # árbol + editor
#   ./scripts/uishot.sh agents 900 1200  # panel de agentes, con tamaño
#   ./scripts/uishot.sh chat
#   UISHOT_MODULE=git ./scripts/uishot.sh sidebar   # barra lateral, módulo Git
#   UISHOT_SECTION=Vault ./scripts/uishot.sh settings  # Configuración, sección Vault
#   UISHOT_SCALE=150 ./scripts/uishot.sh settings   # con la letra al 150 %
#
# UISHOT_MODULE elige qué módulo abre el menú master de la barra lateral
# (connections | ssh | git | notes | http). Solo lo miran las vistas que montan
# el workspace entero; el resto lo ignora.
#
# UISHOT_SCALE es el tamaño de letra de la interfaz en porcentaje (ver
# --ui-font-scale en globals.css). Sirve para comprobar que una pantalla sigue
# entrando con el cuerpo agrandado ANTES de que se lo encuentre alguien que lo
# necesita — que es la única forma de verlo sin abrir la app y cambiar el
# ajuste a mano.
set -euo pipefail

VIEW="${1:-files}"
W="${2:-1280}"
H="${3:-860}"
OUT="${UISHOT_OUT:-/tmp/uishot-$VIEW.png}"
MODULE="${UISHOT_MODULE:-}"
# Sistema operativo simulado para la barra de título propia de la ventana
# (darwin | windows | linux). Solo lo mira la vista `window`.
PLATFORM="${UISHOT_PLATFORM:-}"
SCALE="${UISHOT_SCALE:-}"
# Sección del modal de Configuración que abre la vista `settings`
# (Apariencia | Vault | Terminal | IA). uishot.tsx ya la leía de la URL, pero
# no había forma de pasarla desde acá.
SECTION="${UISHOT_SECTION:-}"
PORT="${UISHOT_PORT:-5199}"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "No se encontró Google Chrome en $CHROME"; exit 1; }

# Esta captura la dibuja vite, que se invoca con pnpm.
source "$(dirname "$0")/ensure-pnpm.sh"

cd "$(dirname "$0")/../frontend"

# Servidor propio y efímero, en un puerto aparte: si el usuario tiene `wails
# dev` corriendo, este no se lo pisa.
pnpm exec vite --port "$PORT" --strictPort >/tmp/uishot-vite.log 2>&1 &
VITE_PID=$!
trap 'kill $VITE_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
    curl -sf "http://localhost:$PORT/uishot.html" >/dev/null && break
    sleep 0.5
done

# --virtual-time-budget deja que React monte y que las promesas de los mocks
# resuelvan antes de disparar: sin eso la foto sale en blanco.
"$CHROME" --headless --disable-gpu --hide-scrollbars \
    --window-size="$W,$H" \
    --virtual-time-budget=4000 \
    --screenshot="$OUT" \
    "http://localhost:$PORT/uishot.html?view=$VIEW&module=$MODULE&platform=$PLATFORM&scale=$SCALE&section=$SECTION" >/dev/null 2>&1

[ -s "$OUT" ] || { echo "La captura salió vacía. Log de vite:"; tail -5 /tmp/uishot-vite.log; exit 1; }
echo "$OUT"
