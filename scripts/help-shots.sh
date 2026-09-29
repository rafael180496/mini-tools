#!/usr/bin/env bash
# Regenera las capturas de la ayuda (index.html / es/index.html) en los dos
# idiomas: inglés en docs/screenshots/, español en docs/screenshots/es/.
#
#   ./scripts/help-shots.sh              todas las de la tabla
#   ./scripts/help-shots.sh ui-http      solo esa
#
# La tabla dice qué vista del banco (scripts/uishot.sh) produce cada archivo y
# con qué tamaño. Las capturas que NO están acá (recortes o tomas viejas de la
# app: editor.png, redis-browser.png, new-connection.png…) no se pueden
# reproducir con el banco; si cambian, hay que sumarlas a esta tabla con su
# vista.
set -euo pipefail
cd "$(dirname "$0")/.."

# archivo  vista[:sección]  ancho  alto
SHOTS='
notes-preview notespreview 1280 700
ui-files files 1100 560
notes-editor notes 1280 760
ui-history history 1200 1200
chat-usage usage 440 400
ui-redis redis 1200 640
notes-folder notesfolder 1000 620
mcp-setup mcp 460 900
ui-agentmode agentmode 1200 860
git-reflog reflog 1000 520
ui-newmenu newmenu 1200 860
ui-panelagents panelagents 1200 860
ui-chatmode chatmode 1200 860
ui-repo repo 1200 860
notes-graph notesgraph 1280 620
git-commit-graph commitgraph 1440 860
ui-http http 1440 900
ui-agents agents 1400 880
ui-workspace workspace 1440 900
sftp-dual sftp 1280 500
grid-edit gridedit 1280 400
unlock-vault unlock 1232 770
sidebar-modules sidebarsearch 1200 760
settings-editor settings 1100 820
settings-ai settings:IA 1100 800
ssh-terminal sshterm 1280 420
ui-chat chat 900 700
ui-thinking thinking 900 560
chat-db chatdb 820 700
settings-full settings:Vault 1100 720
'

mkdir -p docs/screenshots/es
# Puerto propio: si hay otra captura o un `wails dev` en el 5199, no se pisan.
export UISHOT_PORT="${UISHOT_PORT:-5241}"
echo "$SHOTS" | while read -r name view w h; do
    [ -z "$name" ] && continue
    [ -n "${1:-}" ] && [ "$1" != "$name" ] && continue
    section=''
    case "$view" in *:*) section="${view#*:}"; view="${view%%:*}" ;; esac
    UISHOT_LANG=en UISHOT_SECTION="$section" UISHOT_OUT="$PWD/docs/screenshots/$name.png" ./scripts/uishot.sh "$view" "$w" "$h" </dev/null >/dev/null
    UISHOT_LANG=es UISHOT_SECTION="$section" UISHOT_OUT="$PWD/docs/screenshots/es/$name.png" ./scripts/uishot.sh "$view" "$w" "$h" </dev/null >/dev/null
    echo "$name"
done
